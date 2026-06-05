# Post-Game Agent Trace Reveal Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the missing post-game driver that reveals each committed agent inference trace on-chain (`revealAgentInferenceTrace`), flipping the frontend Agent Report badges from grey "committed" to green "verified".

**Architecture:** A pure core (`revealRoomTraces`) takes injected deps (DI, like `maybeFinalizeHeadlessWin`) so it's fully unit-testable; a thin wiring module (`reveal-deps.ts`) supplies real chain/Redis implementations. The core enumerates `AgentInferenceCommitted` events, skips already-`AgentInferenceRevealed` slots, maps each keccak phaseId back to its `D{day}-{KIND}` label (the Redis key uses the label, the on-chain commit uses the keccak), loads the trace blob from Redis, and calls the GM-only reveal from the GM wallet. Two triggers: a manual `POST /agents/reveal-room` endpoint and an automatic fire-and-forget call on `GAME_ENDED`.

**Tech Stack:** TypeScript (ESM), viem, ioredis, express, vitest, supertest. Repo `somnia-mafia-gm-server`, branch `dev`. Spec: `docs/superpowers/specs/2026-06-05-agent-trace-reveal-driver-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/agents/registry-abi.ts` (modify) | Add `revealAgentInferenceTrace` fn + `AgentInferenceRevealed` event to `AGENT_REGISTRY_ABI` |
| `src/agents/redis-keys.ts` (modify) | Add `agentRevealDoneKey` once-claim key |
| `src/agents/reveal-trace.ts` (new) | Pure core: `buildPhaseLabelMap`, `revealRoomTraces`, types. No chain/redis imports. |
| `src/agents/reveal-deps.ts` (new) | Wiring: `buildRevealDeps(chainId, roomId, redis)` — real getLogs / Redis / GM send |
| `src/routes/agentRoutes.ts` (modify) | Add `POST /agents/reveal-room` |
| `src/agents/dispatcher.ts` (modify) | Replace the `TODO 4c` at `GAME_ENDED` with fire-and-forget `revealTraces` |
| `src/agents/index.ts` (modify) | Inject `revealTraces` into the dispatcher deps (next to `sweepAgents`) |
| `test/agents/reveal-abi.test.ts` (new) | ABI surface test |
| `test/agents/reveal-trace.test.ts` (new) | Core unit tests |
| `test/routes/reveal-room.test.ts` (new) | Endpoint test (supertest) |
| `test/agents/dispatcher.test.ts` (modify) | Auto-trigger test |

Run all tests with `npm test` (vitest run). Typecheck/CI gate: `npm run build` (tsc) must pass before every commit.

---

### Task 1: Add the reveal function + event to the registry ABI

**Files:**
- Modify: `src/agents/registry-abi.ts` (the `AGENT_REGISTRY_ABI` `parseAbi([...])` array, ~lines 32-47)
- Test: `test/agents/reveal-abi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agents/reveal-abi.test.ts
import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAbiItem } from "viem";
import { AGENT_REGISTRY_ABI } from "../../src/agents/registry-abi.js";

const B32 = (b: string) => ("0x" + b.repeat(32)) as `0x${string}`;

describe("AGENT_REGISTRY_ABI reveal surface", () => {
  it("exposes revealAgentInferenceTrace with the deployed selector 0x7c9fbbc0", () => {
    const data = encodeFunctionData({
      abi: AGENT_REGISTRY_ABI,
      functionName: "revealAgentInferenceTrace",
      args: [
        1n,
        B32("11"),
        "0x0000000000000000000000000000000000000001",
        0n,
        B32("22"),
        B32("33"),
        B32("44"),
        B32("55"),
      ],
    });
    expect(data.startsWith("0x7c9fbbc0")).toBe(true);
  });

  it("exposes the AgentInferenceRevealed event", () => {
    const ev = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: "AgentInferenceRevealed" });
    expect(ev).toBeTruthy();
    expect(ev?.type).toBe("event");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/reveal-abi.test.ts`
Expected: FAIL — viem throws `AbiFunctionNotFoundError` / `getAbiItem` returns undefined (the fn + event aren't in the ABI yet).

- [ ] **Step 3: Add the two ABI entries**

In `src/agents/registry-abi.ts`, inside the `AGENT_REGISTRY_ABI = parseAbi([...])` array, directly after the `commitAgentInference` line, add:

```ts
  // Post-game reveal (GM-only, room must be ENDED)
  "function revealAgentInferenceTrace(uint256 roomId, bytes32 phaseId, address agent, uint256 somniaRequestId, bytes32 promptHash, bytes32 responseHash, bytes32 actionHash, bytes32 salt)",
  "event AgentInferenceRevealed(uint256 indexed roomId, bytes32 indexed phaseId, address indexed agent, uint256 somniaRequestId, bytes32 promptHash, bytes32 responseHash, bytes32 actionHash)",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/reveal-abi.test.ts`
Expected: PASS (both tests). If the selector test fails, the deployed signature differs from ours — STOP and re-derive the signature from `SomniaSol/contracts/facets/AgentRegistryFacet.sol:179`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry-abi.ts test/agents/reveal-abi.test.ts
git commit -m "feat(agents): bind revealAgentInferenceTrace fn + AgentInferenceRevealed event in registry ABI"
```

---

### Task 2: `buildPhaseLabelMap` — keccak phaseId → label

**Files:**
- Create: `src/agents/reveal-trace.ts`
- Test: `test/agents/reveal-trace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agents/reveal-trace.test.ts
import { describe, it, expect } from "vitest";
import { buildPhaseLabelMap } from "../../src/agents/reveal-trace.js";
import { makePhaseId } from "../../src/agents/trace.js";

describe("buildPhaseLabelMap", () => {
  it("maps each keccak phaseId back to its D{day}-{KIND} label", () => {
    const map = buildPhaseLabelMap(2);
    expect(map.get(makePhaseId("NIGHT", 1).toLowerCase())).toBe("D1-NIGHT");
    expect(map.get(makePhaseId("VOTING", 2).toLowerCase())).toBe("D2-VOTING");
    expect(map.get(makePhaseId("DAY", 1).toLowerCase())).toBe("D1-DAY");
    expect(map.size).toBe(6); // 2 days x 3 kinds
  });

  it("clamps dayCount<1 to at least day 1", () => {
    expect(buildPhaseLabelMap(0).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/reveal-trace.test.ts`
Expected: FAIL — `Cannot find module '../../src/agents/reveal-trace.js'`.

- [ ] **Step 3: Create the file with the helper**

```ts
// src/agents/reveal-trace.ts
import { makePhaseId, type AgentPhaseKind } from "./trace.js";

const KINDS: AgentPhaseKind[] = ["DAY", "VOTING", "NIGHT"];

/**
 * Reverse map keccak(phaseId) -> "D{day}-{KIND}" label, over all days of the
 * game. The on-chain commit/reveal uses the keccak; the Redis trace key uses
 * the label. Mirrors AgentReport.tsx makePhaseLookup.
 */
export function buildPhaseLabelMap(dayCount: number): Map<string, string> {
  const map = new Map<string, string>();
  const days = Math.max(1, dayCount);
  for (let d = 1; d <= days; d++) {
    for (const kind of KINDS) {
      map.set(makePhaseId(kind, d).toLowerCase(), `D${d}-${kind}`);
    }
  }
  return map;
}
```

> If `AgentPhaseKind` is not exported from `trace.ts`, add `export` to its declaration there (it's already used as a param type of `makePhaseId`). Confirm the union is exactly `"DAY" | "VOTING" | "NIGHT"`; if it also contains other kinds, keep `KINDS` limited to these three.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/reveal-trace.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/agents/reveal-trace.ts test/agents/reveal-trace.test.ts
git commit -m "feat(agents): buildPhaseLabelMap (keccak phaseId -> label) for reveal driver"
```

---

### Task 3: `agentRevealDoneKey` + core types + guards

**Files:**
- Modify: `src/agents/redis-keys.ts` (add one key fn near the other `*DoneKey`/claim keys)
- Modify: `src/agents/reveal-trace.ts` (add types + `revealRoomTraces` guards)
- Test: `test/agents/reveal-trace.test.ts` (append)

- [ ] **Step 1: Add the Redis key (no test needed — covered by core tests)**

In `src/agents/redis-keys.ts`, after `agentHeadlessDayKey`, add:

```ts
/** Once-per-(chain,room) claim so the post-game reveal driver runs a room exactly once. */
export function agentRevealDoneKey(chainId: number, roomId: string): string {
  return `${NS}:revealdone:${chainId}:${roomId}`;
}
```

- [ ] **Step 2: Write the failing guard tests**

Append to `test/agents/reveal-trace.test.ts`:

```ts
import { revealRoomTraces, type RevealDeps } from "../../src/agents/reveal-trace.js";
import { vi } from "vitest";

const AGENT = "0x00000000000000000000000000000000000000a1" as `0x${string}`;

function baseDeps(over: Partial<RevealDeps> = {}): RevealDeps {
  return {
    getRoom: vi.fn().mockResolvedValue({ phase: 6, dayCount: 1 }), // ENDED
    getCommittedSlots: vi.fn().mockResolvedValue([]),
    getRevealedKeys: vi.fn().mockResolvedValue(new Set<string>()),
    getTrace: vi.fn().mockResolvedValue(null),
    claimRevealRun: vi.fn().mockResolvedValue(true),
    sendReveal: vi.fn().mockResolvedValue("0xtx"),
    ...over,
  };
}

describe("revealRoomTraces — guards", () => {
  it("disabled when AGENTS_ENABLED!=true", async () => {
    const prev = process.env.AGENTS_ENABLED; process.env.AGENTS_ENABLED = "false";
    const deps = baseDeps();
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    process.env.AGENTS_ENABLED = prev;
    expect(r.status).toBe("disabled");
    expect(deps.getRoom).not.toHaveBeenCalled();
  });

  it("room-not-ended when phase != 6", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({ getRoom: vi.fn().mockResolvedValue({ phase: 5, dayCount: 1 }) });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.status).toBe("room-not-ended");
    expect(deps.claimRevealRun).not.toHaveBeenCalled();
  });

  it("already-claimed when the run-claim is held", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({ claimRevealRun: vi.fn().mockResolvedValue(false) });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.status).toBe("already-claimed");
    expect(deps.getCommittedSlots).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/agents/reveal-trace.test.ts`
Expected: FAIL — `revealRoomTraces` / `RevealDeps` not exported.

- [ ] **Step 4: Add types + the guard portion of the core**

Append to `src/agents/reveal-trace.ts`:

```ts
import type { Address, Hex } from "viem";

export interface RevealSlot {
  phaseIdHex: Hex;
  agent: Address;
  actionHash: Hex;
}

export interface TraceBlob {
  salt?: string;
  somniaRequestId?: string;
  promptHash?: string;
  responseHash?: string;
  actionHash?: string;
}

export interface RevealDeps {
  getRoom(roomId: bigint): Promise<{ phase: number; dayCount: number }>;
  getCommittedSlots(roomId: bigint): Promise<RevealSlot[]>;
  /** Set of "agent:phaseIdHex:actionHash" (all lowercase) already revealed on-chain. */
  getRevealedKeys(roomId: bigint): Promise<Set<string>>;
  /** Trace blob from Redis keyed by phase LABEL (not keccak). null = expired/absent. */
  getTrace(label: string, agent: Address): Promise<TraceBlob | null>;
  /** SETNX once-claim. true = we own the run; false = someone else already did. */
  claimRevealRun(): Promise<boolean>;
  sendReveal(slot: {
    roomId: bigint; phaseIdHex: Hex; agent: Address; somniaRequestId: bigint;
    promptHash: Hex; responseHash: Hex; actionHash: Hex; salt: Hex;
  }): Promise<Hex>;
}

export interface RevealReport {
  roomId: string;
  status: "ok" | "disabled" | "room-not-ended" | "already-claimed";
  total: number;
  revealed: number;
  skipped: { agent: string; phaseIdHex: string; reason: string }[];
  failed: { agent: string; phaseIdHex: string; reason: string }[];
  txHashes: string[];
}

export async function revealRoomTraces(
  { roomId }: { chainId: number; roomId: string },
  deps: RevealDeps
): Promise<RevealReport> {
  const report: RevealReport = {
    roomId, status: "ok", total: 0, revealed: 0, skipped: [], failed: [], txHashes: [],
  };
  if ((process.env.AGENTS_ENABLED ?? "").toLowerCase() !== "true") {
    report.status = "disabled";
    return report;
  }
  const roomIdBig = BigInt(roomId);
  const room = await deps.getRoom(roomIdBig);
  if (room.phase !== 6) {
    report.status = "room-not-ended";
    return report;
  }
  if (!(await deps.claimRevealRun())) {
    report.status = "already-claimed";
    return report;
  }
  // Per-slot processing added in Task 4.
  return report;
}
```

- [ ] **Step 5: Run to verify the guard tests pass**

Run: `npx vitest run test/agents/reveal-trace.test.ts`
Expected: PASS (guards + buildPhaseLabelMap).

- [ ] **Step 6: Commit**

```bash
git add src/agents/redis-keys.ts src/agents/reveal-trace.ts test/agents/reveal-trace.test.ts
git commit -m "feat(agents): reveal driver core types + guards (disabled/not-ended/claim)"
```

---

### Task 4: Core per-slot reveal loop

**Files:**
- Modify: `src/agents/reveal-trace.ts` (replace the Task-3 comment with the loop)
- Test: `test/agents/reveal-trace.test.ts` (append)

- [ ] **Step 1: Write the failing per-slot tests**

Append to `test/agents/reveal-trace.test.ts`:

```ts
import { makePhaseId } from "../../src/agents/trace.js";

const NIGHT1 = makePhaseId("NIGHT", 1);
const VOTE1 = makePhaseId("VOTING", 1);
const AH = "0x00000000000000000000000000000000000000000000000000000000000000ab" as `0x${string}`;

function goodTrace() {
  return {
    salt: "0x" + "ab".repeat(32),
    somniaRequestId: "12847293847561029384",
    promptHash: "0x" + "cd".repeat(32),
    responseHash: "0x" + "ef".repeat(32),
    actionHash: AH,
  };
}

describe("revealRoomTraces — per-slot", () => {
  beforeEach(() => { process.env.AGENTS_ENABLED = "true"; });

  it("happy path: reveals each committed slot, passes keccak phaseId + BigInt reqId", async () => {
    const deps = baseDeps({
      getRoom: vi.fn().mockResolvedValue({ phase: 6, dayCount: 1 }),
      getCommittedSlots: vi.fn().mockResolvedValue([
        { phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH },
      ]),
      getTrace: vi.fn().mockResolvedValue(goodTrace()),
      sendReveal: vi.fn().mockResolvedValue("0xrevealtx"),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.revealed).toBe(1);
    expect(r.txHashes).toEqual(["0xrevealtx"]);
    // GET trace used the LABEL, not the keccak
    expect(deps.getTrace).toHaveBeenCalledWith("D1-NIGHT", AGENT);
    // reveal got the keccak phaseId and a BigInt reqId
    expect(deps.sendReveal).toHaveBeenCalledWith(expect.objectContaining({
      phaseIdHex: NIGHT1,
      somniaRequestId: 12847293847561029384n,
    }));
  });

  it("skips already-revealed slots", async () => {
    const key = `${AGENT.toLowerCase()}:${NIGHT1.toLowerCase()}:${AH.toLowerCase()}`;
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getRevealedKeys: vi.fn().mockResolvedValue(new Set([key])),
      getTrace: vi.fn().mockResolvedValue(goodTrace()),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.revealed).toBe(0);
    expect(deps.sendReveal).not.toHaveBeenCalled();
  });

  it("skips unknown-phase (keccak not in the day map)", async () => {
    const bogus = ("0x" + "99".repeat(32)) as `0x${string}`;
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: bogus, agent: AGENT, actionHash: AH }]),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped).toEqual([{ agent: AGENT, phaseIdHex: bogus, reason: "unknown-phase" }]);
    expect(deps.getTrace).not.toHaveBeenCalled();
  });

  it("skips trace-expired (Redis miss)", async () => {
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getTrace: vi.fn().mockResolvedValue(null),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped[0].reason).toBe("trace-expired");
    expect(deps.sendReveal).not.toHaveBeenCalled();
  });

  it("skips trace-incomplete (missing field)", async () => {
    const { promptHash, ...partial } = goodTrace();
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getTrace: vi.fn().mockResolvedValue(partial),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped[0].reason).toBe("trace-incomplete");
  });

  it("skips actionhash-mismatch", async () => {
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getTrace: vi.fn().mockResolvedValue({ ...goodTrace(), actionHash: "0x" + "00".repeat(32) }),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped[0].reason).toBe("actionhash-mismatch");
  });

  it("partial failure: one reveal throws, the rest still process", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("revert"))
      .mockResolvedValueOnce("0xok");
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([
        { phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH },
        { phaseIdHex: VOTE1, agent: AGENT, actionHash: AH },
      ]),
      getTrace: vi.fn().mockResolvedValue(goodTrace()),
      sendReveal: send,
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.total).toBe(2);
    expect(r.revealed).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toContain("revert");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/agents/reveal-trace.test.ts`
Expected: FAIL — happy path returns 0 reveals (loop not implemented).

- [ ] **Step 3: Implement the per-slot loop**

In `src/agents/reveal-trace.ts`, replace `// Per-slot processing added in Task 4.\n  return report;` with:

```ts
  const labelMap = buildPhaseLabelMap(room.dayCount);
  const slots = await deps.getCommittedSlots(roomIdBig);
  const revealedKeys = await deps.getRevealedKeys(roomIdBig);
  report.total = slots.length;

  for (const slot of slots) {
    const slotKey = `${slot.agent.toLowerCase()}:${slot.phaseIdHex.toLowerCase()}:${slot.actionHash.toLowerCase()}`;
    if (revealedKeys.has(slotKey)) continue;

    const label = labelMap.get(slot.phaseIdHex.toLowerCase());
    if (!label) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "unknown-phase" });
      continue;
    }

    const trace = await deps.getTrace(label, slot.agent);
    if (!trace) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "trace-expired" });
      continue;
    }
    if (!trace.salt || trace.somniaRequestId == null || !trace.promptHash || !trace.responseHash || !trace.actionHash) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "trace-incomplete" });
      continue;
    }
    if (trace.actionHash.toLowerCase() !== slot.actionHash.toLowerCase()) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "actionhash-mismatch" });
      continue;
    }

    try {
      const hash = await deps.sendReveal({
        roomId: roomIdBig,
        phaseIdHex: slot.phaseIdHex,
        agent: slot.agent,
        somniaRequestId: BigInt(trace.somniaRequestId),
        promptHash: trace.promptHash as Hex,
        responseHash: trace.responseHash as Hex,
        actionHash: trace.actionHash as Hex,
        salt: trace.salt as Hex,
      });
      report.revealed += 1;
      report.txHashes.push(hash);
    } catch (err: any) {
      report.failed.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: String(err?.message ?? err) });
    }
  }

  return report;
```

- [ ] **Step 4: Run to verify all core tests pass**

Run: `npx vitest run test/agents/reveal-trace.test.ts`
Expected: PASS (all guard + per-slot + map tests).

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/agents/reveal-trace.ts test/agents/reveal-trace.test.ts
git commit -m "feat(agents): reveal driver per-slot loop (skip/verify/reveal, partial-failure safe)"
```

---

### Task 5: Wiring — `buildRevealDeps`

**Files:**
- Create: `src/agents/reveal-deps.ts`
- (No unit test — exercised by the live smoke in Task 8; keep it thin.)

- [ ] **Step 1: Create the wiring module**

```ts
// src/agents/reveal-deps.ts
import type { Redis } from "ioredis";
import { getAbiItem, type Address, type Hex } from "viem";
import { getChainConfig } from "../chain.js";
import { AGENT_REGISTRY_ABI, DIAMOND_VOTE_ABI } from "./registry-abi.js";
import { agentTraceKey, agentRevealDoneKey, IDEMPOTENCY_TTL_SECONDS } from "./redis-keys.js";
import type { RevealDeps, TraceBlob } from "./reveal-trace.js";

const COMMITTED_EVENT = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: "AgentInferenceCommitted" });
const REVEALED_EVENT = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: "AgentInferenceRevealed" });

/** Scan logs back ~30k blocks in 900-block chunks (matches AgentReport.tsx). */
async function getLogsChunked(publicClient: any, address: Hex, event: any, roomId: bigint) {
  const latest: bigint = await publicClient.getBlockNumber();
  const out: any[] = [];
  for (let offset = 0n; offset < 30000n; offset += 900n) {
    const toBlock = latest > offset ? latest - offset : 0n;
    const fromBlock = toBlock > 900n ? toBlock - 900n : 0n;
    const chunk = await publicClient.getLogs({ address, event, args: { roomId }, fromBlock, toBlock });
    out.push(...chunk);
    if (toBlock === 0n) break;
  }
  return out;
}

export function buildRevealDeps(chainId: number, roomId: string, redis: Redis): RevealDeps {
  const { public: publicClient, wallet: gmWallet, diamond } = getChainConfig(chainId);

  return {
    async getRoom(roomIdBig) {
      const r: any = await publicClient.readContract({
        address: diamond, abi: DIAMOND_VOTE_ABI, functionName: "getRoom", args: [roomIdBig],
      });
      return { phase: Number(r.phase), dayCount: Number(r.dayCount) };
    },

    async getCommittedSlots(roomIdBig) {
      const logs = await getLogsChunked(publicClient, diamond, COMMITTED_EVENT, roomIdBig);
      return logs.map((l: any) => ({
        phaseIdHex: l.args.phaseId as Hex,
        agent: l.args.agent as Address,
        actionHash: l.args.actionHash as Hex,
      }));
    },

    async getRevealedKeys(roomIdBig) {
      const logs = await getLogsChunked(publicClient, diamond, REVEALED_EVENT, roomIdBig);
      return new Set(
        logs.map((l: any) =>
          `${String(l.args.agent).toLowerCase()}:${String(l.args.phaseId).toLowerCase()}:${String(l.args.actionHash).toLowerCase()}`
        )
      );
    },

    async getTrace(label, agent) {
      const raw = await redis.get(agentTraceKey(chainId, roomId, label, agent));
      return raw ? (JSON.parse(raw) as TraceBlob) : null;
    },

    async claimRevealRun() {
      const res = await redis.set(
        agentRevealDoneKey(chainId, roomId), "1", "EX", IDEMPOTENCY_TTL_SECONDS, "NX"
      );
      return res === "OK";
    },

    async sendReveal(s) {
      const hash: Hex = await (gmWallet as any).writeContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "revealAgentInferenceTrace",
        args: [s.roomId, s.phaseIdHex, s.agent, s.somniaRequestId, s.promptHash, s.responseHash, s.actionHash, s.salt],
        gas: 2_000_000n, // light tx: keccak + event; mirrors GAS.commitInference
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`revealAgentInferenceTrace reverted (${hash})`);
      }
      return hash;
    },
  };
}
```

> `gmWallet` is `getChainConfig(chainId).wallet` — the same GM client that signs `resolveNightAsGameMaster` (so it IS the on-chain `gameMaster`; the GM-only check passes). `redis.set(..., "EX", ttl, "NX")` returns `"OK"` or `null` (ioredis).

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: tsc exits 0. (If `getAbiItem` complains the event isn't found, Task 1 wasn't applied — fix that first.)

- [ ] **Step 3: Commit**

```bash
git add src/agents/reveal-deps.ts
git commit -m "feat(agents): buildRevealDeps wiring (getLogs chunked + Redis trace + GM reveal send)"
```

---

### Task 6: Manual endpoint `POST /agents/reveal-room`

**Files:**
- Modify: `src/routes/agentRoutes.ts`
- Test: `test/routes/reveal-room.test.ts`

- [ ] **Step 1: Write the failing endpoint test**

```ts
// test/routes/reveal-room.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock the core + wiring so the route is tested without a chain.
vi.mock("../../src/agents/reveal-trace.js", () => ({
  revealRoomTraces: vi.fn().mockResolvedValue({
    roomId: "72", status: "ok", total: 2, revealed: 2, skipped: [], failed: [], txHashes: ["0xa", "0xb"],
  }),
}));
vi.mock("../../src/agents/reveal-deps.js", () => ({
  buildRevealDeps: vi.fn().mockReturnValue({}),
}));
vi.mock("../../src/redis.js", () => ({ getRedis: () => ({}) }));

import { createAgentRoutes } from "../../src/routes/agentRoutes.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use(createAgentRoutes({ actionLimiter: (_req: any, _res: any, next: any) => next() } as any));
  return a;
}

describe("POST /agents/reveal-room", () => {
  beforeEach(() => { process.env.AGENTS_ENABLED = "true"; delete process.env.AGENTS_API_KEY; });

  it("400 on missing roomId", async () => {
    const res = await request(app()).post("/agents/reveal-room").send({ chainId: 50312 });
    expect(res.status).toBe(400);
  });

  it("400 on non-testnet chainId", async () => {
    const res = await request(app()).post("/agents/reveal-room").send({ roomId: "72", chainId: 1 });
    expect(res.status).toBe(400);
  });

  it("200 returns the reveal report", async () => {
    const res = await request(app()).post("/agents/reveal-room").send({ roomId: "72", chainId: 50312 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roomId: "72", revealed: 2, txHashes: ["0xa", "0xb"] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/routes/reveal-room.test.ts`
Expected: FAIL — route 404s (not registered) so the 200 test fails.

- [ ] **Step 3: Add the route + imports**

In `src/routes/agentRoutes.ts`, add to the imports block (top):

```ts
import { revealRoomTraces } from "../agents/reveal-trace.js";
import { buildRevealDeps } from "../agents/reveal-deps.js";
```

Then add this route directly after the `POST /agents/sweep-room` handler (before `GET /agents/status`):

```ts
  // ── POST /agents/reveal-room ─────────────────────────────────────
  router.post("/agents/reveal-room", ctx.actionLimiter, async (req, res) => {
    try {
      const roomIdRaw = req.body?.roomId;
      if (roomIdRaw == null) {
        return res.status(400).json({ error: "missing roomId" });
      }
      let roomId: bigint;
      try {
        roomId = BigInt(roomIdRaw);
      } catch {
        return res.status(400).json({ error: "roomId not parseable as bigint" });
      }
      const chainId = Number(req.body?.chainId ?? 50312);
      const chainErr = validateAgentTestnet(chainId);
      if (chainErr) return res.status(400).json({ error: chainErr });

      const redis = getRedis();
      if (!redis) {
        return res.status(503).json({ error: "Redis not connected" });
      }
      const deps = buildRevealDeps(chainId, roomId.toString(), redis);
      const report = await revealRoomTraces({ chainId, roomId: roomId.toString() }, deps);
      return res.json(report);
    } catch (err: any) {
      logger.error({ err: err?.message ?? err }, "[agents/reveal-room] failed");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/routes/reveal-room.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run build
git add src/routes/agentRoutes.ts test/routes/reveal-room.test.ts
git commit -m "feat(agents): POST /agents/reveal-room manual reveal endpoint"
```

---

### Task 7: Auto-trigger on `GAME_ENDED`

**Files:**
- Modify: `src/agents/dispatcher.ts` (the `GAME_ENDED` case + the deps interface)
- Modify: `src/agents/index.ts` (inject `revealTraces` next to `sweepAgents`)
- Test: `test/agents/dispatcher.test.ts` (append)

- [ ] **Step 1: Add `revealTraces` to the dispatcher deps type**

In `src/agents/dispatcher.ts`, find the deps interface that declares `sweepAgents?: (chainId: number, roomId: string) => ...`. Add a sibling:

```ts
  revealTraces?: (chainId: number, roomId: string) => Promise<unknown>;
```

- [ ] **Step 2: Replace the TODO at the `GAME_ENDED` case**

In `src/agents/dispatcher.ts`, replace the line `// TODO 4c: dispatch reveal-bundle for all agent traces in this room` (inside `case "GAME_ENDED":`) with:

```ts
        if (this.deps.revealTraces) {
          void Promise.resolve(this.deps.revealTraces(event.chainId, event.roomId)).catch((err) =>
            logger.error({ err, roomId: event.roomId }, "[agents] revealTraces threw")
          );
        }
```

- [ ] **Step 3: Write the failing auto-trigger test**

Append to `test/agents/dispatcher.test.ts` (reuse the file's existing `FakeRedis` + the same `new AgentDispatcher({...})` construction the routing tests use — add `revealTraces: vi.fn()` to that deps object). Add this test:

```ts
describe("AgentDispatcher — GAME_ENDED reveal trigger", () => {
  it("fires revealTraces(chainId, roomId) on GAME_ENDED", async () => {
    const revealTraces = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new AgentDispatcher({
      redis: new FakeRedis() as any,
      revealTraces,
      // ...include the same other deps the existing tests pass to AgentDispatcher
    } as any);

    const endedEvent: AgentEvent = {
      type: "GAME_ENDED",
      chainId: 50312,
      roomId: "72",
      phaseId: "ENDED",
      dayNumber: 0,
      blockNumber: 200,
      txHash: TX_B,
      logIndex: 0,
    } as AgentEvent;

    await dispatcher.dispatch(endedEvent);
    // fire-and-forget — let the microtask run
    await Promise.resolve();
    expect(revealTraces).toHaveBeenCalledWith(50312, "72");
  });
});
```

> Use the dispatch method name the existing tests call (e.g. `dispatcher.dispatch(...)` or `dispatcher.handle(...)`); match the existing tests in this file. If `GAME_ENDED` requires fields the `AgentEvent` union mandates, copy them from the `events.ts` `GAME_ENDED` shape (`phaseId: "ENDED"`).

- [ ] **Step 4: Run to verify it fails, then check it passes after the dispatcher edit**

Run: `npx vitest run test/agents/dispatcher.test.ts`
Expected: PASS for the new test once Steps 1-2 are applied (the mock `revealTraces` is invoked). If it fails because `dispatch` is named differently, align the call to the existing tests.

- [ ] **Step 5: Inject `revealTraces` in the subsystem wiring**

In `src/agents/index.ts`, find where the dispatcher deps object is built (it sets `sweepAgents: ...`). Add the imports at the top:

```ts
import { revealRoomTraces } from "./reveal-trace.js";
import { buildRevealDeps } from "./reveal-deps.js";
import { getRedis } from "../redis.js";
```

And add, next to `sweepAgents`:

```ts
    revealTraces: async (chainId: number, roomId: string) => {
      const redis = getRedis();
      if (!redis) return;
      const deps = buildRevealDeps(chainId, roomId, redis);
      return revealRoomTraces({ chainId, roomId }, deps);
    },
```

> If `getRedis` is already imported in `index.ts`, don't duplicate the import.

- [ ] **Step 6: Typecheck + run full suite**

Run: `npm run build && npm test`
Expected: tsc exits 0; all tests green.

- [ ] **Step 7: Commit**

```bash
git add src/agents/dispatcher.ts src/agents/index.ts test/agents/dispatcher.test.ts
git commit -m "feat(agents): auto-reveal traces on GAME_ENDED (fire-and-forget, idempotent)"
```

---

### Task 8: Live smoke on room 72

**Files:** none (operational verification)

- [ ] **Step 1: Confirm the build + suite are green**

Run: `npm run build && npm test`
Expected: tsc 0; full suite passes (the CI gate).

- [ ] **Step 2: Trigger the manual reveal against the live gm-test** (room 72 traces are within the 7-day TTL)

Run (PowerShell):
```powershell
Invoke-RestMethod -Uri "https://gm-test.mafiaonchain.live/agents/reveal-room" -Method Post -ContentType "application/json" -Body '{"roomId":"72","chainId":50312}' -TimeoutSec 120 | ConvertTo-Json -Depth 6
```
Expected: JSON `RevealReport` with `status:"ok"`, `revealed` > 0, `txHashes` populated.

> This requires the new code to be deployed to gm-test (push `dev` → CI deploy) first, OR run a local gm-server pointed at testnet with the same `GM_PRIVATE_KEY`/`AGENT_MASTER_MNEMONIC`/`REDIS_URL` the live stack uses (so the Redis traces are present). Decide deploy-vs-local with the user before running — pushing `dev` redeploys the live frontend/GM.

- [ ] **Step 3: Verify on-chain + UI**

Re-run the existing chain probe and confirm `AgentInferenceRevealed` events exist for room 72:
```powershell
# reuse the ended72-style scan, scanning for AgentInferenceRevealed on the Diamond for roomId 72
```
Open `mafiaonchain.live` → room 72 post-game → Agent Report → "Autonomy Trace" → confirm action commits now show green **"verified"** instead of grey "committed".

- [ ] **Step 4: Record the proof** (explorer link to one `AgentInferenceRevealed` tx) for the deck/one-pager update.

---

## Self-Review

**Spec coverage:**
- Core `revealRoomTraces` (guards + enumerate + skip-set + per-slot) → Tasks 3, 4 ✅
- phaseId keccak↔label reverse map → Task 2 ✅
- somniaRequestId string→BigInt → Task 4 (happy-path test asserts `12847…n`) ✅
- on-chain enumeration + already-revealed skip → Task 5 (`getCommittedSlots`/`getRevealedKeys`) ✅
- Redis trace GET by label + once-claim → Tasks 3 (key), 5 (wiring) ✅
- GM-only send via GM wallet, gas cap, receipt assert → Task 5 ✅
- Manual endpoint → Task 6 ✅
- Auto-trigger on ENDED + Redis once-claim → Tasks 3 (claim), 7 ✅
- ABI fn + event binding → Task 1 ✅
- Live smoke on room 72 → Task 8 ✅
- Skip reasons unknown-phase / trace-expired / trace-incomplete / actionhash-mismatch / partial-failure → Task 4 tests ✅

**Placeholder scan:** Two intentional "match the existing file" references — Task 7's dispatcher construction and dispatch-method name — because the dispatcher's full deps list lives in `dispatcher.ts`/`index.ts` and must be mirrored exactly rather than guessed. Every code step ships complete code.

**Type consistency:** `RevealDeps`/`RevealReport`/`RevealSlot`/`TraceBlob` defined in Task 3, consumed unchanged in Tasks 4–7. `getTrace(label, agent)` and `claimRevealRun()` signatures match between core (Task 3) and wiring (Task 5). `revealRoomTraces({chainId, roomId}, deps)` call shape identical in endpoint (Task 6) and subsystem wiring (Task 7).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-05-agent-trace-reveal-driver.md`.**

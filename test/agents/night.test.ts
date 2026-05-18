/**
 * Unit tests for NightHandler. Pure in-process — no chain, no LLM, no Redis
 * server. Every external surface is faked.
 *
 * Coverage:
 *   - happy path mafia: inferToolsChat → decode → commit → trace stored
 *   - citizen / unassigned role → deterministic SKIP commit (no LLM call)
 *   - LLM timeout (result=null) → fallback target, commit still fires
 *   - decodeNightToolCall direct unit tests
 *   - action idempotency: second handle() short-circuits before LLM
 *   - on-chain commitment present → skipped-already-committed
 *   - PHASE != NIGHT → empty outcome
 *   - no on-chain agents → empty outcome
 *   - inferToolsChat throws → infer-failed + action key released
 *   - commit tx throws → commit-failed but trace IS persisted
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encodeAbiParameters,
  parseAbiParameters,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

import {
  NightHandler,
  decodeNightToolCall,
  buildNightPrompt,
  type NightChainOps,
  type NightStartedEvent,
  type RoomSnapshot,
  type PlayerSnapshot,
} from "../../src/agents/night.js";
import {
  agentActionProcessedKey,
  agentRoleKey,
  agentTraceKey,
} from "../../src/agents/redis-keys.js";
import { AgentRole, setAgentRole } from "../../src/agents/roles.js";
import { nightActionHash } from "../../src/agents/registry-abi.js";
import {
  computeTraceCommitment,
  makePhaseId,
} from "../../src/agents/trace.js";
import { deriveAgentWallets } from "../../src/agents/wallets.js";
import type { InferToolsChatResult } from "../../src/agents/llm-tools-call.js";

// ─── In-memory Redis fake (mirrors voting test) ────────────────────────────
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async set(
    key: string,
    value: string,
    ...args: any[]
  ): Promise<"OK" | null> {
    let nx = false;
    let exSeconds: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "NX") nx = true;
      if (a === "EX") exSeconds = Number(args[i + 1]);
    }
    const existing = this.store.get(key);
    const now = Date.now();
    const alive =
      existing && (existing.expiresAt == null || existing.expiresAt > now);
    if (nx && alive) return null;
    this.store.set(key, {
      value,
      expiresAt: exSeconds != null ? now + exSeconds * 1000 : null,
    });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    if (!v) return null;
    if (v.expiresAt != null && v.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return v.value;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const CHAIN_ID = 50312;
const DIAMOND: Hex = "0x031b6746155ce11c7b533935f4674f5fc4682338";
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const ROOM_ID = 7n;
const DAY_COUNT = 2;
const PHASE_NIGHT = 5;
const ZERO32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";

const COMMIT_TX_HASH_PREFIX = "0xbbbb";
const LLM_TX_HASH: Hex =
  "0xcccc000000000000000000000000000000000000000000000000000000000001";

function nightEvent(over: Partial<NightStartedEvent> = {}): NightStartedEvent {
  return {
    type: "NIGHT_STARTED",
    chainId: CHAIN_ID,
    roomId: ROOM_ID.toString(),
    phaseId: `D${DAY_COUNT}-NIGHT`,
    dayNumber: DAY_COUNT,
    blockNumber: 100,
    txHash: "0x1111000000000000000000000000000000000000000000000000000000000000",
    logIndex: 0,
    ...over,
  };
}

interface FakeChainState {
  room: RoomSnapshot;
  players: PlayerSnapshot[];
  agentSet: Set<string>;
  existingCommitment: Hex;
}

function makeFakeChain(
  state: FakeChainState,
  spies: {
    sendCommit?: ReturnType<typeof vi.fn>;
  } = {}
): NightChainOps {
  const sendCommit =
    spies.sendCommit ??
    vi.fn(async (_account, _roomId, _phaseId, _actionHash, traceCommitment: Hex) => {
      return ((COMMIT_TX_HASH_PREFIX +
        traceCommitment.slice(2, 6).toLowerCase() +
        "0".repeat(58)) as Hex);
    });

  return {
    chainId: CHAIN_ID,
    diamond: DIAMOND,
    publicClient: {} as any,
    getRoom: vi.fn(async () => state.room),
    getPlayers: vi.fn(async () => state.players),
    isAgent: vi.fn(async (_roomId, addr) =>
      state.agentSet.has(addr.toLowerCase())
    ),
    getAgentTraceCommitment: vi.fn(async () => state.existingCommitment),
    sendCommitInference: sendCommit,
    buildAgentWalletClient: vi.fn(() => ({} as any)),
  };
}

function deriveAddrs(count: number, roomId: bigint = ROOM_ID): Address[] {
  return deriveAgentWallets(TEST_MNEMONIC, roomId, count).map((w) => w.address);
}

function activePlayer(addr: Address, flags: number = 0x2): PlayerSnapshot {
  return { wallet: addr, flags };
}

function encodeToolCalldata(signature: string, target: Address): Hex {
  const selector = toFunctionSelector(signature);
  const args = encodeAbiParameters(parseAbiParameters("address"), [target]);
  return (selector + args.slice(2)) as Hex;
}

function makeToolsResult(over: {
  pendingToolCalls?: Hex[];
  finishReason?: string;
  response?: string;
  status?: number;
  requestId?: bigint;
}): InferToolsChatResult {
  const status = over.status ?? 2;
  return {
    result:
      status === 2
        ? {
            finishReason: over.finishReason ?? "tool_calls",
            response: over.response ?? "",
            pendingToolCalls: over.pendingToolCalls ?? [],
            pendingToolCallIds: ["call_1"],
            status,
          }
        : null,
    status,
    requestId: over.requestId ?? 42n,
    txHash: LLM_TX_HASH,
    latencySec: 1.2,
  };
}

// ─── decodeNightToolCall direct tests ──────────────────────────────────────

describe("decodeNightToolCall", () => {
  const self: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const t1: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const t2: Address = "0xcccccccccccccccccccccccccccccccccccccccc";

  it("mafia: valid mafiaKill calldata picks target from pool", () => {
    const cd = encodeToolCalldata("mafiaKill(address)", t1);
    const dec = decodeNightToolCall(cd, AgentRole.MAFIA, self, [self, t1, t2]);
    expect(dec.kind).toBe("KILL");
    expect(dec.target.toLowerCase()).toBe(t1.toLowerCase());
    expect(dec.source).toBe("llm");
  });

  it("doctor: heal self is allowed (allowSelf=true)", () => {
    const cd = encodeToolCalldata("doctorHeal(address)", self);
    const dec = decodeNightToolCall(cd, AgentRole.DOCTOR, self, [self, t1, t2]);
    expect(dec.kind).toBe("HEAL");
    expect(dec.target.toLowerCase()).toBe(self.toLowerCase());
    expect(dec.source).toBe("llm");
  });

  it("detective: cannot check self → fallback", () => {
    const cd = encodeToolCalldata("detectiveCheck(address)", self);
    const dec = decodeNightToolCall(cd, AgentRole.DETECTIVE, self, [self, t1, t2]);
    expect(dec.kind).toBe("CHECK");
    expect(dec.source).toBe("fallback");
    // Lowest of (t1, t2) — both lowercase same letters, t1=0xbb..., t2=0xcc...
    expect(dec.target.toLowerCase()).toBe(t1.toLowerCase());
  });

  it("wrong selector for role → fallback", () => {
    // Mafia agent gets doctorHeal calldata — selector mismatch
    const cd = encodeToolCalldata("doctorHeal(address)", t1);
    const dec = decodeNightToolCall(cd, AgentRole.MAFIA, self, [self, t1, t2]);
    expect(dec.kind).toBe("KILL");
    expect(dec.source).toBe("fallback");
  });

  it("off-pool target → fallback", () => {
    const offPool: Address = "0xdddddddddddddddddddddddddddddddddddddddd";
    const cd = encodeToolCalldata("mafiaKill(address)", offPool);
    const dec = decodeNightToolCall(cd, AgentRole.MAFIA, self, [self, t1, t2]);
    expect(dec.kind).toBe("KILL");
    expect(dec.source).toBe("fallback");
    expect(dec.fallbackReason).toContain("not in allowed pool");
  });

  it("no calldata → fallback (lowest pool)", () => {
    const dec = decodeNightToolCall(null, AgentRole.MAFIA, self, [self, t1, t2]);
    expect(dec.kind).toBe("KILL");
    expect(dec.source).toBe("fallback");
    expect(dec.fallbackReason).toContain("no calldata");
  });

  it("malformed calldata (too short) → fallback", () => {
    const dec = decodeNightToolCall(
      "0xdeadbe" as Hex,
      AgentRole.MAFIA,
      self,
      [self, t1, t2]
    );
    expect(dec.kind).toBe("KILL");
    expect(dec.source).toBe("fallback");
  });
});

// ─── buildNightPrompt direct test ─────────────────────────────────────────

describe("buildNightPrompt", () => {
  const self: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const t1: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("mafia gets only mafiaKill tool, prompt excludes self", () => {
    const p = buildNightPrompt({
      self,
      role: AgentRole.MAFIA,
      alive: [self, t1],
      dayCount: 2,
      language: "English",
    });
    expect(p.tools).toHaveLength(1);
    expect(p.tools[0].signature).toBe("mafiaKill(address)");
    expect(p.messages[1]).toContain(t1);
    // self mentioned in "Your wallet" line but not in the "Alive players (not you)" list
    expect(p.messages[1]).toContain(`Alive players (not you): ${t1}`);
  });

  it("doctor sees full alive list (allowSelf=true)", () => {
    const p = buildNightPrompt({
      self,
      role: AgentRole.DOCTOR,
      alive: [self, t1],
      dayCount: 2,
      language: "English",
    });
    expect(p.tools[0].signature).toBe("doctorHeal(address)");
    expect(p.messages[1]).toContain(`Alive players: ${self}, ${t1}`);
  });
});

// ─── NightHandler integration ─────────────────────────────────────────────

describe("NightHandler", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  function buildHandler(opts: {
    chain: NightChainOps;
    inferToolsFn?: (req: any, opts: any) => Promise<InferToolsChatResult>;
  }) {
    return new NightHandler({
      redis: redis as any,
      chainOpsFor: () => opts.chain,
      mnemonic: TEST_MNEMONIC,
      inferToolsFn: opts.inferToolsFn as any,
    });
  }

  it("happy path: mafia agent — infer → decode → commit → trace stored", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.MAFIA);

    const cd = encodeToolCalldata("mafiaKill(address)", otherAddr);
    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    const inferToolsFn = vi.fn(async () =>
      makeToolsResult({ pendingToolCalls: [cd], requestId: 77n })
    );

    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("committed");
    expect(outcomes[0].action).toBe("KILL");
    expect(outcomes[0].target?.toLowerCase()).toBe(otherAddr.toLowerCase());
    expect(outcomes[0].decisionSource).toBe("llm");
    expect(outcomes[0].role).toBe(AgentRole.MAFIA);
    expect(outcomes[0].commitTxHash?.startsWith(COMMIT_TX_HASH_PREFIX)).toBe(true);

    expect(inferToolsFn).toHaveBeenCalledTimes(1);
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(1);

    const cArgs = (chain.sendCommitInference as any).mock.calls[0];
    expect(cArgs[1]).toBe(ROOM_ID);
    expect(cArgs[2]).toBe(makePhaseId("NIGHT", DAY_COUNT));
    expect(cArgs[3]).toBe(nightActionHash("KILL", otherAddr));

    const traceRaw = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-NIGHT`, agentAddr)
    );
    expect(traceRaw).not.toBeNull();
    const trace = JSON.parse(traceRaw!);
    expect(trace.action).toBe("KILL");
    expect(trace.target.toLowerCase()).toBe(otherAddr.toLowerCase());
    expect(trace.somniaRequestId).toBe("77");
    expect(trace.actionHash).toBe(nightActionHash("KILL", otherAddr));
    expect(trace.role).toBe(AgentRole.MAFIA);

    // Verify off-chain commitment reproduces what was sent
    const expected = computeTraceCommitment({
      diamond: DIAMOND,
      chainId: BigInt(CHAIN_ID),
      roomId: ROOM_ID,
      phaseId: makePhaseId("NIGHT", DAY_COUNT),
      agent: agentAddr,
      salt: trace.salt,
      somniaRequestId: 77n,
      promptHash: trace.promptHash,
      responseHash: trace.responseHash,
      actionHash: trace.actionHash,
    });
    expect(cArgs[4]).toBe(expected);
    expect(trace.traceCommitment).toBe(expected);
  });

  it("citizen role → deterministic SKIP commit (no LLM)", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.CITIZEN);

    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    const inferToolsFn = vi.fn();
    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("committed");
    expect(outcomes[0].action).toBe("SKIP");
    expect(outcomes[0].target).toBe(ZERO_ADDR);
    expect(outcomes[0].decisionSource).toBe("skip");
    expect(outcomes[0].role).toBe(AgentRole.CITIZEN);

    expect(inferToolsFn).not.toHaveBeenCalled();
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(1);

    const cArgs = (chain.sendCommitInference as any).mock.calls[0];
    expect(cArgs[3]).toBe(nightActionHash("SKIP", ZERO_ADDR));
  });

  it("no role assigned → SKIP path", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    // No setAgentRole — getAgentRole returns NONE
    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const handler = buildHandler({ chain, inferToolsFn: vi.fn() });
    const outcomes = await handler.handle(nightEvent());
    expect(outcomes[0].status).toBe("committed");
    expect(outcomes[0].action).toBe("SKIP");
    expect(outcomes[0].role).toBe(AgentRole.NONE);
  });

  it("LLM result null (timeout) → fallback target, commit fires", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.MAFIA);

    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    const inferToolsFn = vi.fn(async () => makeToolsResult({ status: 0 }));
    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes[0].status).toBe("committed");
    expect(outcomes[0].action).toBe("KILL");
    expect(outcomes[0].decisionSource).toBe("fallback");
    expect(outcomes[0].target?.toLowerCase()).toBe(otherAddr.toLowerCase());
  });

  it("action idempotency: second handle() short-circuits before LLM", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.DOCTOR);

    // Pre-claim the action key
    await redis.set(
      agentActionProcessedKey(
        CHAIN_ID,
        ROOM_ID.toString(),
        `D${DAY_COUNT}-NIGHT`,
        agentAddr,
        "night"
      ),
      JSON.stringify({ startedAt: 0 }),
      "EX",
      60,
      "NX"
    );

    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    const inferToolsFn = vi.fn();
    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes[0].status).toBe("skipped-action-idempotent");
    expect(inferToolsFn).not.toHaveBeenCalled();
    expect(chain.sendCommitInference).not.toHaveBeenCalled();
  });

  it("on-chain commitment present → skipped-already-committed", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.MAFIA);
    const existing: Hex =
      "0x1234123412341234123412341234123412341234123412341234123412341234";

    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: existing,
    });

    const inferToolsFn = vi.fn();
    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes[0].status).toBe("skipped-already-committed");
    expect(inferToolsFn).not.toHaveBeenCalled();
    expect(chain.sendCommitInference).not.toHaveBeenCalled();
  });

  it("PHASE != NIGHT → empty outcome", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    const chain = makeFakeChain({
      room: { phase: 4, dayCount: DAY_COUNT, aliveCount: 2 }, // VOTING
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const handler = buildHandler({ chain, inferToolsFn: vi.fn() });
    const outcomes = await handler.handle(nightEvent());
    expect(outcomes).toEqual([]);
  });

  it("no on-chain agents → empty outcome", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set(), // nobody is an agent
      existingCommitment: ZERO32,
    });
    const handler = buildHandler({ chain, inferToolsFn: vi.fn() });
    const outcomes = await handler.handle(nightEvent());
    expect(outcomes).toEqual([]);
  });

  it("inferToolsChat throws → infer-failed + action key released", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.MAFIA);

    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    const inferToolsFn = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes[0].status).toBe("infer-failed");
    expect(outcomes[0].err).toContain("rpc down");
    expect(chain.sendCommitInference).not.toHaveBeenCalled();

    // Action key should have been released so a retry can re-run.
    const releasedKey = await redis.get(
      agentActionProcessedKey(
        CHAIN_ID,
        ROOM_ID.toString(),
        `D${DAY_COUNT}-NIGHT`,
        agentAddr,
        "night"
      )
    );
    expect(releasedKey).toBeNull();
  });

  it("commit tx throws → commit-failed but trace IS persisted", async () => {
    const [agentAddr, otherAddr] = deriveAddrs(2);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), agentAddr, AgentRole.MAFIA);

    const cd = encodeToolCalldata("mafiaKill(address)", otherAddr);
    const failingCommit = vi.fn(async () => {
      throw new Error("commit reverted");
    });
    const chain = makeFakeChain(
      {
        room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 2 },
        players: [activePlayer(agentAddr), activePlayer(otherAddr)],
        agentSet: new Set([agentAddr.toLowerCase()]),
        existingCommitment: ZERO32,
      },
      { sendCommit: failingCommit }
    );

    const inferToolsFn = vi.fn(async () =>
      makeToolsResult({ pendingToolCalls: [cd] })
    );
    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes[0].status).toBe("commit-failed");
    expect(outcomes[0].action).toBe("KILL");
    expect(outcomes[0].decisionSource).toBe("llm");

    // Trace still persisted so a retry can re-issue the commit
    const traceRaw = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-NIGHT`, agentAddr)
    );
    expect(traceRaw).not.toBeNull();
    const trace = JSON.parse(traceRaw!);
    expect(trace.commitTxHash).toBeNull();
  });

  it("parallelism: 2 agents (mafia + doctor) → both commit independently", async () => {
    const [mafia, doctor, civilian] = deriveAddrs(3);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), mafia, AgentRole.MAFIA);
    await setAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), doctor, AgentRole.DOCTOR);

    const mafiaCd = encodeToolCalldata("mafiaKill(address)", civilian);
    const doctorCd = encodeToolCalldata("doctorHeal(address)", civilian);

    const chain = makeFakeChain({
      room: { phase: PHASE_NIGHT, dayCount: DAY_COUNT, aliveCount: 3 },
      players: [activePlayer(mafia), activePlayer(doctor), activePlayer(civilian)],
      agentSet: new Set([mafia.toLowerCase(), doctor.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    // Return appropriate calldata per caller. inferToolsFn receives the prompt
    // and can dispatch by tool list — we identify by signature.
    const inferToolsFn = vi.fn(async (req: any) => {
      const sig = req.onchainTools[0]?.signature ?? "";
      const cd = sig.startsWith("mafia") ? mafiaCd : doctorCd;
      return makeToolsResult({ pendingToolCalls: [cd] });
    });

    const handler = buildHandler({ chain, inferToolsFn });
    const outcomes = await handler.handle(nightEvent());

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.action).sort()).toEqual(["HEAL", "KILL"]);
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(2);
  });
});

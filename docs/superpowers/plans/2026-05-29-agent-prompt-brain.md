# Agent prompt "full brain" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Mafia agents situational awareness (role census, win-state math, death reactions) and chain-derived memory/suspicion in their prompts, plus stop mafia from targeting teammates.

**Architecture:** Three new *pure* modules (`game-math`, `reads`, `private-strategy`) compute prompt lines from already-available data (on-chain `room:logs`, `getPlayers`, Redis role keyspaces). They feed the **existing** `publicContext[]` / `privateMemory[]` channels that `day.ts` / `night.ts` / `decision-schema.ts` already accept, so prompt *structure* changes only where a behavioral directive is needed. Win counting reuses `win-detect.computeWinner` (one source of truth).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, viem, ioredis. Spec: `docs/superpowers/specs/2026-05-29-agent-prompt-brain-design.md`.

---

## File Structure

**New (`src/agents/`):**
- `game-math.ts` — pure. `roleCensus`, `computeWinMath`, `censusLines`, `townWinLines`, `mafiaWinLines`. Reuses `win-detect.computeWinner`.
- `reads.ts` — pure. `deriveReads(rounds, self, nameOf)` → suspicion/consistency lines.
- `private-strategy.ts` — `loadRoomRoles(redis, chainId, roomId)` (Redis) + `buildPrivateStrategyLines(args)` (pure).

**Modified (`src/agents/`):**
- `strategic-context.ts` — inject census + town-win lines; expose `latestNightDeath`/`latestNightHappened`/`latestVoteOut`; add `loadAgentReadsLines`.
- `day.ts` — death-reaction opener + persona-stance hint in `buildDayPrompt`; load room roles once per `handle`; append strategy + reads to `privateMemory`.
- `night.ts` — teammates into `buildNightPrompt` + `decodeNightToolCall`; append mafia strategy line.
- `decision-schema.ts` — voting urgency directive in `buildVotePrompt` system text.
- `voting.ts` — load room roles once; append strategy + reads to `privateMemory`; pass `startingActive`.

**Tests (`test/agents/`):** `game-math.test.ts`, `reads.test.ts`, `private-strategy.test.ts` (new); extend `day.test.ts`, `night.test.ts`, `voting.test.ts`, `strategic-context.test.ts` (create if absent).

**Run tests:** `npx vitest run <path>` (single file) or `npx vitest run test/agents` (suite).

---

## Task 1: `game-math.ts` — census + win math (pure)

**Files:**
- Create: `src/agents/game-math.ts`
- Test: `test/agents/game-math.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agents/game-math.test.ts
import { describe, it, expect } from "vitest";
import {
  roleCensus,
  computeWinMath,
  censusLines,
  townWinLines,
  mafiaWinLines,
} from "../../src/agents/game-math.js";

describe("roleCensus", () => {
  it("6 players → 2 mafia, 1 doctor, 1 detective, 2 citizens", () => {
    expect(roleCensus(6)).toEqual({ total: 6, mafia: 2, doctor: 1, detective: 1, citizens: 2 });
  });
  it("boundary 5 → 1 mafia; 9 → 3 mafia; 12 → 4 mafia", () => {
    expect(roleCensus(5).mafia).toBe(1);
    expect(roleCensus(9).mafia).toBe(3);
    expect(roleCensus(12).mafia).toBe(4);
  });
  it("4 players → doctor but no detective", () => {
    expect(roleCensus(4)).toEqual({ total: 4, mafia: 1, doctor: 1, detective: 0, citizens: 2 });
  });
});

describe("computeWinMath", () => {
  it("2 mafia / 3 town → 1 town death to mafia win", () => {
    expect(computeWinMath({ aliveCount: 5, mafiaAlive: 2 })).toEqual({
      aliveCount: 5, mafiaAlive: 2, townAlive: 3, townDeathsToMafiaWin: 1,
    });
  });
  it("never negative", () => {
    expect(computeWinMath({ aliveCount: 2, mafiaAlive: 2 }).townDeathsToMafiaWin).toBe(0);
  });
});

describe("prompt lines", () => {
  it("censusLines states setup + headcount", () => {
    const lines = censusLines(6, 4);
    expect(lines[0]).toContain("2 Mafia, 1 Doctor, 1 Detective, 2 Citizens");
    expect(lines[1]).toContain("Alive now: 4 of 6");
    expect(lines[1]).toContain("Eliminated so far: 2");
  });
  it("townWinLines gives positive slack message when town has room", () => {
    const lines = townWinLines({ aliveNow: 5, startingMafia: 2 });
    expect(lines.join(" ")).toContain("at most 1 more");
  });
  it("townWinLines warns when at parity edge", () => {
    const lines = townWinLines({ aliveNow: 4, startingMafia: 2 });
    expect(lines.join(" ")).toContain("one good night from parity");
  });
  it("mafiaWinLines states exact counts + teammates", () => {
    const lines = mafiaWinLines({ mafiaAlive: 2, townAlive: 3, teammateNames: ["Alice"] });
    expect(lines[0]).toContain("you + Alice");
    expect(lines[1]).toContain("Town deaths still needed to win: 1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/game-math.test.ts`
Expected: FAIL — `Cannot find module '../../src/agents/game-math.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agents/game-math.ts
/**
 * agents/game-math.ts — pure game-state math for agent prompts.
 * Role census (deterministic, public; mirrors crypto/sra.generateDistributedDeck)
 * + win-state math. No Redis, no chain. See 2026-05-29-agent-prompt-brain-design.md.
 */
export interface RoleCensus {
  total: number;
  mafia: number;
  doctor: number;
  detective: number;
  citizens: number;
}

/** Mirrors generateDistributedDeck / LibGame.expectedMafiaCount. */
export function roleCensus(startingActive: number): RoleCensus {
  const n = Math.max(0, Math.trunc(startingActive));
  const mafia = n < 1 ? 0 : n <= 5 ? 1 : n <= 8 ? 2 : n <= 11 ? 3 : 4;
  const doctor = n >= 4 ? 1 : 0;
  const detective = n >= 5 ? 1 : 0;
  const citizens = Math.max(0, n - mafia - doctor - detective);
  return { total: n, mafia, doctor, detective, citizens };
}

export interface WinMath {
  aliveCount: number;
  mafiaAlive: number;
  townAlive: number;
  /** Town deaths still needed for Mafia to reach parity (and win). */
  townDeathsToMafiaWin: number;
}

export function computeWinMath(args: { aliveCount: number; mafiaAlive: number }): WinMath {
  const aliveCount = Math.max(0, Math.trunc(args.aliveCount));
  const mafiaAlive = Math.max(0, Math.trunc(args.mafiaAlive));
  const townAlive = Math.max(0, aliveCount - mafiaAlive);
  return { aliveCount, mafiaAlive, townAlive, townDeathsToMafiaWin: Math.max(0, townAlive - mafiaAlive) };
}

export function censusLines(startingActive: number, aliveNow: number): string[] {
  const c = roleCensus(startingActive);
  const dead = Math.max(0, c.total - aliveNow);
  return [
    `Game setup: ${c.total} players — ${c.mafia} Mafia, ${c.doctor} Doctor, ${c.detective} Detective, ${c.citizens} Citizens. Roles are revealed only when the game ends.`,
    `Alive now: ${aliveNow} of ${c.total}. Eliminated so far: ${dead} (their roles stay hidden).`,
  ];
}

export function townWinLines(args: { aliveNow: number; startingMafia: number }): string[] {
  const aliveNow = Math.max(0, Math.trunc(args.aliveNow));
  const startingMafia = Math.max(0, Math.trunc(args.startingMafia));
  const worstMafia = Math.min(startingMafia, aliveNow);
  const slack = aliveNow - 2 * worstMafia;
  const lines = ["Town wins by voting out every Mafia. Town LOSES the instant living Town <= living Mafia."];
  if (slack > 0) {
    lines.push(`Worst case all ${startingMafia} Mafia are still alive — Town can afford to lose at most ${slack} more of its own before Mafia can reach parity. Make this vote count.`);
  } else {
    lines.push(`If every starting Mafia is still alive, Mafia may already be one good night from parity — do not waste this vote.`);
  }
  return lines;
}

export function mafiaWinLines(args: { mafiaAlive: number; townAlive: number; teammateNames: string[] }): string[] {
  const m = computeWinMath({ aliveCount: args.mafiaAlive + args.townAlive, mafiaAlive: args.mafiaAlive });
  const team = args.teammateNames.length > 0 ? `you + ${args.teammateNames.join(", ")}` : `you (no confirmed living teammates)`;
  return [
    `Your Mafia team: ${team}. Mafia alive: ${m.mafiaAlive}.`,
    `Exact count — Mafia alive: ${m.mafiaAlive}, Town alive: ${m.townAlive}. You win when Mafia >= Town. Town deaths still needed to win: ${m.townDeathsToMafiaWin}.`,
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/game-math.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/agents/game-math.ts test/agents/game-math.test.ts
git commit -m "feat(agents): add game-math (role census + win-state math)"
```

---

## Task 2: `strategic-context.ts` — inject census/win lines + expose deaths

**Files:**
- Modify: `src/agents/strategic-context.ts`
- Test: `test/agents/strategic-context.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// test/agents/strategic-context.test.ts
import { describe, it, expect } from "vitest";
import { loadPublicGameContext } from "../../src/agents/strategic-context.js";
import type { Address } from "viem";

class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
}
const CHAIN = 50312, ROOM = "7";
const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;

function logsKey() { return `room:logs:${CHAIN}:${ROOM}`; }

describe("loadPublicGameContext census + deaths", () => {
  it("prepends census + town-win lines when startingActive given", async () => {
    const r = new FakeRedis();
    r.store.set(logsKey(), JSON.stringify([{ eventType: "DayStarted", eventData: { dayNumber: 1 } }]));
    const ctx = await loadPublicGameContext(r as any, {
      chainId: CHAIN, roomId: ROOM, currentDay: 2, alive: [A, B, C], self: A, startingActive: 6,
    });
    expect(ctx.lines[0]).toContain("Game setup: 6 players");
    expect(ctx.lines.join("\n")).toContain("Town LOSES the instant");
  });

  it("exposes latestNightDeath and latestVoteOut from logs", async () => {
    const r = new FakeRedis();
    r.store.set(logsKey(), JSON.stringify([
      { eventType: "DayStarted", eventData: { dayNumber: 1 } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: B, targetAddress: C } },
      { eventType: "VOTING_RESULT", eventData: { playerAddress: C } },
      { eventType: "DayStarted", eventData: { dayNumber: 2 } },
      { eventType: "NIGHT_RESULT", eventData: { playerAddress: B } },
      { eventType: "DayStarted", eventData: { dayNumber: 3 } },
    ]));
    const ctx = await loadPublicGameContext(r as any, {
      chainId: CHAIN, roomId: ROOM, currentDay: 3, alive: [A], self: A, startingActive: 6,
    });
    expect(ctx.latestVoteOut?.toLowerCase()).toBe(C.toLowerCase());
    expect(ctx.latestNightDeath?.toLowerCase()).toBe(B.toLowerCase());
    expect(ctx.latestNightHappened).toBe(true);
  });

  it("latestNightHappened true + latestNightDeath null on a safe night", async () => {
    const r = new FakeRedis();
    r.store.set(logsKey(), JSON.stringify([
      { eventType: "DayStarted", eventData: { dayNumber: 1 } },
      { eventType: "NIGHT_RESULT", eventData: { isSafe: true } },
      { eventType: "DayStarted", eventData: { dayNumber: 2 } },
    ]));
    const ctx = await loadPublicGameContext(r as any, {
      chainId: CHAIN, roomId: ROOM, currentDay: 2, alive: [A], self: A,
    });
    expect(ctx.latestNightHappened).toBe(true);
    expect(ctx.latestNightDeath).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/strategic-context.test.ts`
Expected: FAIL — `latestNightDeath`/`latestNightHappened`/`startingActive` not present; census lines missing.

- [ ] **Step 3: Implement — extend the type, args, and line assembly**

In `src/agents/strategic-context.ts`, add the import near the top (after the existing imports):

```ts
import { censusLines, townWinLines, roleCensus } from "./game-math.js";
```

Extend the return type:

```ts
export type PublicGameContext = {
  lines: string[];
  consensusTarget: Address | null;
  stalledVoteRounds: number;
  latestNightDeath: Address | null;
  latestNightHappened: boolean;
  latestVoteOut: Address | null;
};
```

Add `startingActive?: number;` to the `args` object type of `loadPublicGameContext` (alongside `maxVoteDays?`, `includeCurrentDayVotes?`).

Inside `loadPublicGameContext`, replace the `const lines = [ ... ];` initialiser and the final `return` with:

```ts
  const prefix: string[] = [];
  if (args.startingActive && args.startingActive > 0) {
    prefix.push(
      ...censusLines(args.startingActive, args.alive.length),
      ...townWinLines({ aliveNow: args.alive.length, startingMafia: roleCensus(args.startingActive).mafia })
    );
  }

  const lines = [
    ...prefix,
    `Elimination threshold today: ${required}/${args.alive.length} alive votes.`,
  ];
```

(Leave the rest of the body — `latestVote`/`latestNight`/recap/stall/consensus blocks — unchanged.)

Then change the final `return` to include the new fields:

```ts
  return {
    lines,
    consensusTarget,
    stalledVoteRounds: stalled,
    latestNightDeath: latestNight && latestNight.killed && latestNight.killed !== ZERO_ADDR ? latestNight.killed : null,
    latestNightHappened: !!latestNight,
    latestVoteOut: latestVote?.eliminated ?? null,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/strategic-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing suite to confirm no regression**

Run: `npx vitest run test/agents`
Expected: PASS (additive change; `loadPublicGameContextLines` still returns `.lines`).

- [ ] **Step 6: Commit**

```bash
git add src/agents/strategic-context.ts test/agents/strategic-context.test.ts
git commit -m "feat(agents): census/win-bound lines + expose latest death/vote-out in context"
```

---

## Task 3: `private-strategy.ts` — room roles + mafia private lines

**Files:**
- Create: `src/agents/private-strategy.ts`
- Test: `test/agents/private-strategy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agents/private-strategy.test.ts
import { describe, it, expect } from "vitest";
import { loadRoomRoles, buildPrivateStrategyLines } from "../../src/agents/private-strategy.js";
import { AgentRole } from "../../src/agents/roles.js";
import type { Address } from "viem";

class FakeRedis {
  store = new Map<string, string>();
  async keys(pattern: string) {
    const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return [...this.store.keys()].filter((k) => re.test(k));
  }
  async mget(keys: string[]) { return keys.map((k) => this.store.get(k) ?? null); }
}

const CHAIN = 50312, ROOM = "7";
const SELF = "0xaaaa000000000000000000000000000000000001" as Address;
const MATE = "0xbbbb000000000000000000000000000000000002" as Address;
const T1 = "0xcccc000000000000000000000000000000000003" as Address;
const T2 = "0xdddd000000000000000000000000000000000004" as Address;
const nameOf = (a: string) => ({ [MATE.toLowerCase()]: "Alice" } as Record<string, string>)[a.toLowerCase()] ?? a.slice(0, 6);

describe("loadRoomRoles", () => {
  it("reads the agents:role keyspace", async () => {
    const r = new FakeRedis();
    r.store.set(`agents:role:${CHAIN}:${ROOM}:${SELF.toLowerCase()}`, "1");
    r.store.set(`agents:role:${CHAIN}:${ROOM}:${MATE.toLowerCase()}`, "1");
    r.store.set(`agents:role:${CHAIN}:${ROOM}:${T1.toLowerCase()}`, "4");
    const roles = await loadRoomRoles(r as any, CHAIN, ROOM);
    expect(roles.get(SELF.toLowerCase())).toBe(AgentRole.MAFIA);
    expect(roles.get(T1.toLowerCase())).toBe(AgentRole.CITIZEN);
  });
});

describe("buildPrivateStrategyLines", () => {
  const roles = new Map<string, AgentRole>([
    [SELF.toLowerCase(), AgentRole.MAFIA],
    [MATE.toLowerCase(), AgentRole.MAFIA],
    [T1.toLowerCase(), AgentRole.CITIZEN],
    [T2.toLowerCase(), AgentRole.DOCTOR],
  ]);

  it("mafia: exact counts + teammate names + secrecy guard", () => {
    const lines = buildPrivateStrategyLines({ role: AgentRole.MAFIA, roles, alive: [SELF, MATE, T1, T2], self: SELF, nameOf });
    const joined = lines.join("\n");
    expect(joined).toContain("you + Alice");
    expect(joined).toContain("Mafia alive: 2, Town alive: 2");
    expect(joined).toContain("Town deaths still needed to win: 0");
    expect(joined).toContain("Never hint that you know");
  });

  it("mafia night adds the no-self-kill line", () => {
    const lines = buildPrivateStrategyLines({ role: AgentRole.MAFIA, roles, alive: [SELF, MATE, T1, T2], self: SELF, nameOf, forNight: true });
    expect(lines.join("\n")).toContain("Never target your own team");
  });

  it("town roles get no lines", () => {
    expect(buildPrivateStrategyLines({ role: AgentRole.DOCTOR, roles, alive: [SELF, T1], self: T1, nameOf })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/private-strategy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/agents/private-strategy.ts
/**
 * agents/private-strategy.ts — role-conditional PRIVATE prompt lines.
 * Mafia get exact win-state math + a teammate roster (never broadcast; the
 * secrecy guard line keeps it out of public chat). Town roles get nothing here
 * (they rely on the public bound + their own factual memory).
 */
import type { Redis } from "ioredis";
import type { Address } from "viem";
import { AgentRole } from "./roles.js";
import { mafiaWinLines } from "./game-math.js";

type NameOf = (addr: string) => string;

/**
 * Scan room role keyspaces → Map<lowerAddr, AgentRole>. Mirrors the keyspaces
 * win-detect.resolveRolesWithFallback reads, but Redis-only (no GMStore):
 *   agents:role:{chain}:{room}:{addr}      (split idx 4)  — all-agent + agent rows
 *   gm:room:{chain}:{room}:role:{addr}     (split idx 5)  — human SRA-submitted rows
 * First writer wins per address.
 */
export async function loadRoomRoles(
  redis: Pick<Redis, "keys" | "mget">,
  chainId: number,
  roomId: string
): Promise<Map<string, AgentRole>> {
  const out = new Map<string, AgentRole>();
  const sources: { pattern: string; idx: number }[] = [
    { pattern: `agents:role:${chainId}:${roomId}:*`, idx: 4 },
    { pattern: `gm:room:${chainId}:${roomId}:role:*`, idx: 5 },
  ];
  for (const { pattern, idx } of sources) {
    const keys = await redis.keys(pattern);
    if (keys.length === 0) continue;
    const vals = await redis.mget(keys);
    for (let i = 0; i < keys.length; i++) {
      const addr = keys[i].split(":")[idx];
      const raw = vals[i];
      if (!addr || raw == null) continue;
      const role = Number(raw) as AgentRole;
      const lower = addr.toLowerCase();
      if (!out.has(lower)) out.set(lower, role);
    }
  }
  return out;
}

export function buildPrivateStrategyLines(args: {
  role: AgentRole;
  roles: Map<string, AgentRole>;
  alive: readonly Address[];
  self: Address;
  nameOf: NameOf;
  forNight?: boolean;
}): string[] {
  if (args.role !== AgentRole.MAFIA) return [];

  const selfLower = args.self.toLowerCase();
  const aliveLower = args.alive.map((a) => a.toLowerCase());

  const mafiaSet = new Set(aliveLower.filter((a) => args.roles.get(a) === AgentRole.MAFIA));
  mafiaSet.add(selfLower); // self is mafia even if its own role row is missing
  const mafiaAlive = aliveLower.filter((a) => mafiaSet.has(a)).length;
  const townAlive = Math.max(0, aliveLower.length - mafiaAlive);
  const teammateNames = aliveLower.filter((a) => a !== selfLower && mafiaSet.has(a)).map((a) => args.nameOf(a));

  const lines = mafiaWinLines({ mafiaAlive, townAlive, teammateNames });

  const unresolved = aliveLower.some((a) => a !== selfLower && !args.roles.has(a));
  if (unresolved && teammateNames.length === 0) {
    lines.push(`(A teammate's role is unconfirmed — at least 1 Mafia is alive; play it safe.)`);
  }

  lines.push(
    `Never hint that you know who the other Mafia are. In public, treat your teammates as ordinary players — do not coordinate openly, defend them suspiciously, or say "we".`
  );
  if (args.forNight) {
    lines.push(`Never target your own team. Prioritise anyone you can read as Doctor or Detective.`);
  }
  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/private-strategy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/private-strategy.ts test/agents/private-strategy.test.ts
git commit -m "feat(agents): private-strategy (room roles + mafia exact math/roster)"
```

---

## Task 4: `reads.ts` + `loadAgentReadsLines` — chain-derived suspicion/memory

**Files:**
- Create: `src/agents/reads.ts`
- Modify: `src/agents/strategic-context.ts` (add `loadAgentReadsLines`)
- Test: `test/agents/reads.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agents/reads.test.ts
import { describe, it, expect } from "vitest";
import { deriveReads } from "../../src/agents/reads.js";
import type { Address } from "viem";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const A = "0x2222222222222222222222222222222222222222" as Address;
const B = "0x3333333333333333333333333333333333333333" as Address;
const C = "0x4444444444444444444444444444444444444444" as Address;
const nameOf = (a: string) => ({ [A.toLowerCase()]: "A", [B.toLowerCase()]: "B", [C.toLowerCase()]: "C" } as Record<string, string>)[a.toLowerCase()] ?? "me";

describe("deriveReads", () => {
  it("flags who voted against me", () => {
    const lines = deriveReads([{ day: 1, votes: [{ from: A, to: ME }] }], ME, nameOf);
    expect(lines.join("\n")).toContain("A voted against you on Day 1");
  });
  it("flags a flip across rounds", () => {
    const lines = deriveReads([
      { day: 1, votes: [{ from: A, to: B }] },
      { day: 2, votes: [{ from: A, to: C }] },
    ], ME, nameOf);
    expect(lines.join("\n")).toContain("A switched from voting B to voting C");
  });
  it("flags repeated bandwagon partners", () => {
    const lines = deriveReads([
      { day: 1, votes: [{ from: A, to: C }, { from: B, to: C }] },
      { day: 2, votes: [{ from: A, to: B }, { from: B, to: A }] },
      { day: 3, votes: [{ from: A, to: C }, { from: B, to: C }] },
    ], ME, nameOf);
    expect(lines.join("\n")).toContain("A and B keep voting together");
  });
  it("reminds me of my own last vote", () => {
    const lines = deriveReads([{ day: 1, votes: [{ from: ME, to: A }] }], ME, nameOf);
    expect(lines.join("\n")).toContain("You previously voted A");
  });
  it("empty logs → no lines", () => {
    expect(deriveReads([], ME, nameOf)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/reads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `reads.ts`**

```ts
// src/agents/reads.ts
/**
 * agents/reads.ts — pure, chain-derived "reads" lines for an agent's private
 * memory. Derived ONLY from on-chain vote rounds (no chat-text summarization),
 * so a player can't steer another agent's suspicion by typing.
 */
import type { Address } from "viem";

export type ReadsVote = { from: Address; to: Address };
export type ReadsRound = { day: number; votes: ReadsVote[] };
type NameOf = (addr: string) => string;

export function deriveReads(rounds: readonly ReadsRound[], self: Address, nameOf: NameOf): string[] {
  const me = self.toLowerCase();
  const lines: string[] = [];

  // 1. Voted against me.
  for (const r of rounds)
    for (const v of r.votes)
      if (v.to.toLowerCase() === me && v.from.toLowerCase() !== me)
        lines.push(`${nameOf(v.from)} voted against you on Day ${r.day}.`);

  // 2. Bandwagon pairs (same target same day, on >= 2 days).
  const pairDays = new Map<string, Set<number>>();
  for (const r of rounds) {
    const byTarget = new Map<string, string[]>();
    for (const v of r.votes) {
      const t = v.to.toLowerCase();
      (byTarget.get(t) ?? byTarget.set(t, []).get(t)!).push(v.from.toLowerCase());
    }
    for (const voters of byTarget.values()) {
      const uniq = [...new Set(voters)].filter((a) => a !== me).sort();
      for (let i = 0; i < uniq.length; i++)
        for (let j = i + 1; j < uniq.length; j++) {
          const key = `${uniq[i]}|${uniq[j]}`;
          (pairDays.get(key) ?? pairDays.set(key, new Set()).get(key)!).add(r.day);
        }
    }
  }
  for (const [key, days] of pairDays)
    if (days.size >= 2) {
      const [a, b] = key.split("|");
      lines.push(`${nameOf(a)} and ${nameOf(b)} keep voting together.`);
    }

  // 3. Flips: a voter whose target changed between rounds.
  const lastTarget = new Map<string, string>();
  for (const r of rounds)
    for (const v of r.votes) {
      const f = v.from.toLowerCase();
      if (f === me) continue;
      const cur = v.to.toLowerCase();
      const prev = lastTarget.get(f);
      if (prev && prev !== cur)
        lines.push(`${nameOf(f)} switched from voting ${nameOf(prev)} to voting ${nameOf(cur)}.`);
      lastTarget.set(f, cur);
    }

  // 4. Own last stance (consistency).
  let myLast: string | null = null;
  for (const r of rounds) for (const v of r.votes) if (v.from.toLowerCase() === me) myLast = v.to.toLowerCase();
  if (myLast) lines.push(`You previously voted ${nameOf(myLast)}. Stay consistent unless new evidence changed your mind.`);

  return [...new Set(lines)].slice(0, 6);
}
```

- [ ] **Step 4: Run `reads.ts` test (passes)**

Run: `npx vitest run test/agents/reads.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `loadAgentReadsLines` to `strategic-context.ts`**

`parseLogs` and `parseVoteRounds` already exist in this file. Add the import at the top:

```ts
import { deriveReads, type ReadsRound } from "./reads.js";
```

Append this exported function at the end of `strategic-context.ts`:

```ts
export async function loadAgentReadsLines(
  redis: Pick<Redis, "get">,
  args: { chainId: number; roomId: string; self: Address; nameOf?: NameOf }
): Promise<string[]> {
  const logs = parseLogs(await redis.get(roomLogsKey(args.chainId, args.roomId)));
  const rounds: ReadsRound[] = parseVoteRounds(logs).map((r) => ({ day: r.day, votes: r.votes }));
  const nameOf = args.nameOf ?? ((a: string) => a.toLowerCase().slice(0, 7));
  return deriveReads(rounds, args.self, nameOf);
}
```

- [ ] **Step 6: Add an integration test for `loadAgentReadsLines`**

Append to `test/agents/strategic-context.test.ts`:

```ts
import { loadAgentReadsLines } from "../../src/agents/strategic-context.js";

describe("loadAgentReadsLines", () => {
  it("derives reads from room:logs vote rounds", async () => {
    const r = new FakeRedis();
    r.store.set(`room:logs:${CHAIN}:${ROOM}`, JSON.stringify([
      { eventType: "DayStarted", eventData: { dayNumber: 1 } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: B, targetAddress: A } },
    ]));
    const lines = await loadAgentReadsLines(r as any, { chainId: CHAIN, roomId: ROOM, self: A });
    expect(lines.join("\n")).toContain("voted against you on Day 1");
  });
});
```

- [ ] **Step 7: Run + commit**

Run: `npx vitest run test/agents/reads.test.ts test/agents/strategic-context.test.ts`
Expected: PASS.

```bash
git add src/agents/reads.ts src/agents/strategic-context.ts test/agents/reads.test.ts test/agents/strategic-context.test.ts
git commit -m "feat(agents): chain-derived reads (suspicion/consistency) + loadAgentReadsLines"
```

---

## Task 5: `day.ts` — death-reaction opener, persona stance, wire strategy + reads

**Files:**
- Modify: `src/agents/day.ts`
- Test: `test/agents/day.test.ts`

- [ ] **Step 1: Write the failing test (pure `buildDayPrompt`)**

Append to `test/agents/day.test.ts` (it already imports `buildDayPrompt`; add the import if missing):

```ts
import { buildDayPrompt } from "../../src/agents/day.js";
import { AgentRole } from "../../src/agents/roles.js";

describe("buildDayPrompt situational additions", () => {
  const base = {
    self: "0x1111111111111111111111111111111111111111" as const,
    role: AgentRole.CITIZEN,
    persona: "loud sceptical accuser",
    alive: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"] as any,
    recentChat: [] as string[],
    dayNumber: 2,
    language: "English",
  };

  it("emits a death-reaction opener when a night victim is given", () => {
    const { messages } = buildDayPrompt({ ...base, sinceLastRound: { nightDeathName: "Bob" } });
    expect(messages.join("\n")).toContain("Bob was killed last night");
  });
  it("emits a peaceful-night opener when the night was safe", () => {
    const { messages } = buildDayPrompt({ ...base, sinceLastRound: { peacefulNight: true } });
    expect(messages.join("\n")).toContain("nobody died last night");
  });
  it("no death opener on day 1", () => {
    const { messages } = buildDayPrompt({ ...base, dayNumber: 1, sinceLastRound: { nightDeathName: "Bob" } });
    expect(messages.join("\n")).not.toContain("was killed last night");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/agents/day.test.ts -t "situational additions"`
Expected: FAIL — `sinceLastRound` not a known property / opener absent.

- [ ] **Step 3: Implement in `day.ts`**

Extend `DayPromptArgs` (add after `language: string;`):

```ts
  /** Behavioral opener material derived from the last round (C3). */
  sinceLastRound?: { nightDeathName?: string; peacefulNight?: boolean; voteOutName?: string };
```

Inside `buildDayPrompt`, build the opener and a persona stance hint. Add just before the `const user = [` array:

```ts
  const sr = args.sinceLastRound ?? {};
  const deathOpener =
    args.dayNumber > 1 && sr.nightDeathName
      ? `PRIORITY: ${sr.nightDeathName} was killed last night. Open by reacting to it — who benefits, who pushed or defended ${sr.nightDeathName}, does this kill clear or implicate anyone? Don't ignore the body.`
      : args.dayNumber > 1 && sr.peacefulNight
      ? `PRIORITY: nobody died last night — a save, a missed kill, or a no-op. Who might have been protected (a Doctor read), and who did the Mafia likely aim at?`
      : ``;
  const voteOpener =
    args.dayNumber > 1 && sr.voteOutName
      ? `Last round the town voted out ${sr.voteOutName}. If last night's outcome suggests that was a mistake, say so.`
      : ``;
  const stance = /loud|bold|accus|paranoid|impatient/i.test(args.persona)
    ? `Take the lead: name a concrete suspect and push.`
    : /quiet|calm|cautious|soft|observer|mediator/i.test(args.persona)
    ? `Probe before committing: ask a pointed question or weigh two suspects.`
    : `State a clear read.`;
```

Then add `deathOpener`, `voteOpener`, and `stance` into the `user` array. Insert them right after the `firstDayRule` entry:

```ts
    firstDayRule,
    deathOpener,
    voteOpener,
    stance,
```

(The array is already `.filter(Boolean)`-ed, so empty strings drop out.)

- [ ] **Step 4: Run to verify pure test passes**

Run: `npx vitest run test/agents/day.test.ts -t "situational additions"`
Expected: PASS.

- [ ] **Step 5: Wire strategy + reads + startingActive into the handler**

In `day.ts`, add imports:

```ts
import { loadRoomRoles, buildPrivateStrategyLines } from "./private-strategy.js";
import { loadAgentReadsLines, loadPublicGameContext } from "./strategic-context.js";
```

(Keep the existing `loadPublicGameContextLines` import or replace its uses — below we switch to the full `loadPublicGameContext`.)

In `handle()`, after `myAgents` is resolved and before the `for (const wallet of order)` loop, load roles once. `handle()` already fetched `players`, so capture the total count here too:

```ts
    const roomRoles = await loadRoomRoles(this.deps.redis, event.chainId, event.roomId).catch(() => new Map());
    const totalPlayers = players.length;
```

Pass both `roomRoles` and `totalPlayers` through `handleOneAgent`'s args object (add them to the args type, the destructure, and the call site).

In `handleOneAgent`, replace the `publicContext` load with the full-context call and derive `sinceLastRound`. `startingActive` is the **total** player count (`args.totalPlayers`), not the alive count:

```ts
    const ctx = await loadPublicGameContext(this.deps.redis, {
      chainId: chain.chainId, roomId: event.roomId, currentDay: event.dayNumber,
      alive: aliveAddrs, self: wallet.address, nameOf, startingActive: args.totalPlayers,
    }).catch(() => null);
    const publicContext = ctx?.lines ?? [];
    const sinceLastRound = {
      nightDeathName: ctx?.latestNightDeath ? nameOf(ctx.latestNightDeath) : undefined,
      peacefulNight: !!ctx?.latestNightHappened && !ctx?.latestNightDeath,
      voteOutName: ctx?.latestVoteOut ? nameOf(ctx.latestVoteOut) : undefined,
    };
```

Append strategy + reads to `privateMemory` (after the existing `privateMemory` load):

```ts
    const stratLines = buildPrivateStrategyLines({ role, roles: args.roomRoles, alive: aliveAddrs, self: wallet.address, nameOf, forNight: false });
    const readsLines = await loadAgentReadsLines(this.deps.redis, { chainId: chain.chainId, roomId: event.roomId, self: wallet.address, nameOf }).catch(() => []);
    const privateMemoryFull = [...privateMemory, ...stratLines, ...readsLines];
```

Pass `privateMemory: privateMemoryFull` and `sinceLastRound` into the `buildDayPrompt({ ... })` call.

- [ ] **Step 6: Run the full day suite**

Run: `npx vitest run test/agents/day.test.ts`
Expected: PASS (mocks return `[]` for empty Redis; new lines are additive).

- [ ] **Step 7: Commit**

```bash
git add src/agents/day.ts test/agents/day.test.ts
git commit -m "feat(agents): DAY death-reaction opener + persona stance + wire strategy/reads"
```

---

## Task 6: `decision-schema.ts` + `voting.ts` — urgency directive + wire strategy/reads

**Files:**
- Modify: `src/agents/decision-schema.ts`, `src/agents/voting.ts`
- Test: `test/agents/voting.test.ts`

- [ ] **Step 1: Write the failing test (pure `buildVotePrompt`)**

Append to `test/agents/voting.test.ts`:

```ts
import { buildVotePrompt } from "../../src/agents/decision-schema.js";

describe("buildVotePrompt urgency", () => {
  it("system text tells the agent to consolidate under loss-pressure", () => {
    const { system } = buildVotePrompt({
      self: "0x1111111111111111111111111111111111111111" as any,
      alive: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"] as any,
      publicChat: [], dayCount: 2,
    });
    expect(system).toContain("consolidate");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/agents/voting.test.ts -t "urgency"`
Expected: FAIL — "consolidate" not present.

- [ ] **Step 3: Add the directive in `decision-schema.ts`**

In `buildVotePrompt`, add one entry to the `system: [ ... ]` array (before `Reply language: ${lang}.`):

```ts
      `Use the situation briefing. If the town is one mistake from losing, do NOT spend your vote on a long-shot — consolidate on your strongest Mafia read or the consensus leader. Never vote a player the public record has effectively cleared.`,
```

- [ ] **Step 4: Run to verify pure test passes**

Run: `npx vitest run test/agents/voting.test.ts -t "urgency"`
Expected: PASS.

- [ ] **Step 5: Wire strategy + reads + startingActive into `voting.ts`**

Add imports:

```ts
import { loadRoomRoles, buildPrivateStrategyLines } from "./private-strategy.js";
import { loadAgentReadsLines } from "./strategic-context.js";
import { getAgentRole } from "./roles.js";
```

In `handle()`, after `myAgents` is resolved, load roles once and remember the total player count:

```ts
    const roomRoles = await loadRoomRoles(this.deps.redis, event.chainId, event.roomId).catch(() => new Map());
    const totalPlayers = players.length;
```

Pass `roomRoles` and `totalPlayers` into each `handleOneAgent({ ... })` call (add to its args type + destructure).

In `handleOneAgent`, add `startingActive: totalPlayers` to the `loadPublicGameContext({ ... })` call.

After the existing `privateMemory` load, append strategy + reads:

```ts
    const role = await getAgentRole(this.deps.redis, chain.chainId, event.roomId, wallet.address);
    const stratLines = buildPrivateStrategyLines({ role, roles: args.roomRoles, alive: allAlive, self: wallet.address, nameOf });
    const readsLines = await loadAgentReadsLines(this.deps.redis, { chainId: chain.chainId, roomId: event.roomId, self: wallet.address, nameOf }).catch(() => []);
    const privateMemoryFull = [...privateMemory, ...stratLines, ...readsLines];
```

Pass `privateMemory: privateMemoryFull` into the `buildVotePrompt({ ... })` call.

- [ ] **Step 6: Run the full voting suite**

Run: `npx vitest run test/agents/voting.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agents/decision-schema.ts src/agents/voting.ts test/agents/voting.test.ts
git commit -m "feat(agents): voting urgency directive + wire mafia strategy/reads"
```

---

## Task 7: `night.ts` — mafia teammate roster + no-self-kill (prompt + decode)

**Files:**
- Modify: `src/agents/night.ts`
- Test: `test/agents/night.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/agents/night.test.ts`:

```ts
describe("night mafia teammate handling", () => {
  const MAFIA: Address = "0xaaaa000000000000000000000000000000000001";
  const MATE: Address = "0xbbbb000000000000000000000000000000000002";
  const TOWN1: Address = "0xcccc000000000000000000000000000000000003";
  const TOWN2: Address = "0xdddd000000000000000000000000000000000004";

  it("buildNightPrompt lists teammates and forbids targeting them", () => {
    const { messages } = buildNightPrompt({
      self: MAFIA, role: AgentRole.MAFIA, alive: [MAFIA, MATE, TOWN1, TOWN2],
      dayCount: 2, language: "English", teammates: [MATE],
      nameOf: (a) => (a.toLowerCase() === MATE.toLowerCase() ? "Alice" : a.slice(0, 6)),
    });
    const joined = messages.join("\n");
    expect(joined).toContain("Alice");
    expect(joined.toLowerCase()).toContain("never target");
  });

  it("decodeNightToolCall re-routes a kill that targets a teammate", () => {
    const calldata = (toFunctionSelector("mafiaKill(address)") +
      encodeAbiParameters(parseAbiParameters("address"), [MATE]).slice(2)) as Hex;
    const decision = decodeNightToolCall(calldata, AgentRole.MAFIA, MAFIA, [MAFIA, MATE, TOWN1, TOWN2], { teammates: [MATE] });
    expect(decision.target.toLowerCase()).not.toBe(MATE.toLowerCase());
    expect(decision.kind).toBe("KILL");
  });

  it("decodeNightToolCall fallback never picks a teammate", () => {
    const decision = decodeNightToolCall("0x", AgentRole.MAFIA, MAFIA, [MAFIA, MATE, TOWN1], { teammates: [MATE] });
    expect([TOWN1.toLowerCase()]).toContain(decision.target.toLowerCase());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/agents/night.test.ts -t "teammate"`
Expected: FAIL — `teammates` not honored; decode picks the teammate.

- [ ] **Step 3: Implement teammate-aware decode**

In `night.ts`, extend `NightPromptArgs` and `NightDecisionOptions`:

```ts
// in NightPromptArgs:
  teammates?: Address[];
  nameOf?: (addr: string) => string;
```

```ts
// in NightDecisionOptions:
  teammates?: Address[];
```

Update `filterPool` to also drop teammates:

```ts
function filterPool(
  pool: readonly Address[],
  self: Address,
  allowSelf: boolean,
  teammates: readonly Address[] = []
): Address[] {
  const team = new Set(teammates.map((a) => a.toLowerCase()));
  return pool.filter((a) => {
    const lo = a.toLowerCase();
    if (!allowSelf && lo === self.toLowerCase()) return false;
    return !team.has(lo);
  });
}
```

In `decodeNightToolCall`, thread `opts.teammates` into every `deterministicPick`/`filterPool` call (the three `deterministicPick(pool, self, meta.allowSelf, opts.fallbackSeed)` sites and the `filterPool(pool, self, meta.allowSelf)` validation site become `... , opts.teammates ?? []`). Update `deterministicPick` signature the same way:

```ts
function deterministicPick(
  pool: readonly Address[],
  self: Address,
  allowSelf: boolean,
  seed = 0,
  teammates: readonly Address[] = []
): Address {
  const filtered = filterPool(pool, self, allowSelf, teammates);
  if (filtered.length === 0) return ZERO_ADDR;
  const sorted = [...filtered].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const idx = Math.abs(Math.trunc(seed)) % sorted.length;
  return sorted[idx];
}
```

In `buildNightPrompt`, when `role === AgentRole.MAFIA` and `teammates?.length`, add a roster line to the system message and exclude teammates from the shown "Alive players" list:

```ts
  const nameOf = args.nameOf ?? ((a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`);
  const teammateLower = new Set((args.teammates ?? []).map((a) => a.toLowerCase()));
  const teammateLine =
    role === AgentRole.MAFIA && (args.teammates?.length ?? 0) > 0
      ? ` Your Mafia teammates: ${(args.teammates ?? []).map((a) => nameOf(a)).join(", ")}. Never target them.`
      : ``;
```

Append `teammateLine` to the system string (the first `[...].join(" ")`), and filter the kill list shown to mafia: where the user message currently lists `(role === AgentRole.DOCTOR ? args.alive : others)`, for MAFIA exclude teammates — change the `others` used for the kill candidate list to also drop teammates:

```ts
  const killCandidates = others.filter((a) => !teammateLower.has(a.toLowerCase()));
```

and use `killCandidates` in the `Alive players (not you): ...` line for the MAFIA branch.

- [ ] **Step 4: Run to verify the teammate tests pass**

Run: `npx vitest run test/agents/night.test.ts -t "teammate"`
Expected: PASS.

- [ ] **Step 5: Wire roles → teammates + strategy line into the night handler**

Add imports:

```ts
import { loadRoomRoles, buildPrivateStrategyLines } from "./private-strategy.js";
```

In `handle()`, after `myAgents` is resolved, load roles once:

```ts
    const roomRoles = await loadRoomRoles(this.deps.redis, event.chainId, event.roomId).catch(() => new Map());
```

Pass `roomRoles` into `handleOneAgent` → `handleActiveRolePath`.

In `handleActiveRolePath`, derive teammates (alive mafia minus self) and pass them into both the prompt and the decode, and append the mafia strategy line to `privateMemory`:

```ts
    const aliveLower = allAlive.map((a) => a.toLowerCase());
    const teammates = aliveLower
      .filter((a) => a !== wallet.address.toLowerCase() && (args.roomRoles.get(a) === AgentRole.MAFIA))
      .map((a) => allAlive.find((x) => x.toLowerCase() === a)!) as Address[];

    const stratLines = buildPrivateStrategyLines({ role, roles: args.roomRoles, alive: allAlive, self: wallet.address, nameOf, forNight: true });
    const privateMemoryFull = [...privateMemory, ...stratLines];
```

Pass `teammates` + `nameOf` into the `buildNightPrompt({ ... })` call, `privateMemory: privateMemoryFull`, and add `teammates` to the `decodeNightToolCall(..., { fallbackSeed: ..., teammates })` opts.

- [ ] **Step 6: Run the full night suite**

Run: `npx vitest run test/agents/night.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agents/night.ts test/agents/night.test.ts
git commit -m "feat(agents): mafia teammate roster + no-self-kill (night prompt + decode)"
```

---

## Task 8: Full-suite regression + typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the entire agents suite**

Run: `npx vitest run test/agents`
Expected: PASS — all new + existing tests green.

- [ ] **Step 2: Typecheck the package**

Run: `npx tsc --noEmit`
Expected: no errors. (If `decodeNightToolCall` callers in scripts break, update them to pass `{}`.)

- [ ] **Step 3: Commit any typecheck fixups**

```bash
git add -A
git commit -m "chore(agents): typecheck fixups for prompt-brain wiring"
```

---

## Self-Review

**1. Spec coverage:**
- C1 census + win-bound → Task 1 (`game-math`) + Task 2 (inject into context). ✓
- C2 mafia private math + roster → Task 3 (`private-strategy`), wired in Tasks 5/6/7. ✓
- C3 death-reaction (incl. peaceful night) → Task 5 (`buildDayPrompt` opener). ✓
- C4 chain-derived reads → Task 4 (`reads` + `loadAgentReadsLines`), wired in Tasks 5/6. ✓
- C5 voting urgency → Task 6. ✓
- C6 anti-self-sabotage (teammate exclusion) + persona nudge → Task 7 (night) + Task 5 (persona stance). ✓
- Reuse `win-detect.computeWinner` → used via `game-math` math + counts in `private-strategy`. (Note: `game-math` re-implements the alive count only inside `mafiaWinLines` via `computeWinMath`; the *win rule* numbers come from the spec's parity formula, which equals `computeWinner`'s. `private-strategy` derives `mafiaAlive` from the resolved role map directly — equivalent to `computeWinner`'s count — so no divergence.) ✓
- `loadRoomRoles` loaded once per `handle()` → Tasks 5/6/7 each load once. ✓
- `decodeNightToolCall` teammates optional → via `NightDecisionOptions.teammates`. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**3. Type consistency:**
- `buildPrivateStrategyLines({ role, roles, alive, self, nameOf, forNight? })` — same shape in Tasks 3, 5, 6, 7. ✓
- `loadRoomRoles(redis, chainId, roomId): Map<string, AgentRole>` — same in 3, 5, 6, 7. ✓
- `loadAgentReadsLines(redis, { chainId, roomId, self, nameOf? })` — same in 4, 5, 6. ✓
- `loadPublicGameContext` return now has `latestNightDeath`/`latestNightHappened`/`latestVoteOut` (Task 2) consumed in Task 5. ✓
- `sinceLastRound: { nightDeathName?, peacefulNight?, voteOutName? }` — defined Task 5 Step 3, used Step 5. ✓
- `ReadsRound`/`ReadsVote` — defined Task 4, used by `loadAgentReadsLines`. ✓

**Open implementation note:** `startingActive` is the **total** player count (`args.totalPlayers` = `players.length`), not the alive count — `getPlayers` is append-only so dead players keep their slot (verified in spec self-review). One tiny check while writing `reads.ts`/Task 4: confirm `PLAYER_VOTED` logs carry `targetAddress` alongside `voterAddress` (live vote-recaps prove they do).

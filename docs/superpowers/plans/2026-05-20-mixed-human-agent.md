# Mixed human + agent games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a mixed human+agent Mafia game resolve and confirm roles in REVEAL so it reaches DAY and plays to a win (the all-agent path stays as-is).

**Architecture:** Extract the GM role-resolution core from `eciesRoutes` into a shared `roleResolution` service (`submitSraKey` + `maybeResolveRoles` + an in-process `onResolved` pub/sub). In a mixed game `PreGameHandler.handleReveal` injects each agent's SRA key into that service instead of resolving server-direct; when the union of all keys (agents + the human's HTTP submit) is present the service resolves and fires `onResolved`, which the agent subsystem subscribes to → `confirmResolvedRoles` commits each agent's role. No polling (it would stall the single-threaded event listener).

**Tech Stack:** TypeScript (NodeNext ESM), viem, ioredis, vitest. Reuses `src/crypto/sra.ts` (`resolveRolesFromDeck`), `src/agents/role-sync.ts`, `src/stores/index.ts` (`GMStore`), `src/ws/wsManager.ts`.

**Spec:** `docs/superpowers/specs/2026-05-20-mixed-human-agent-design.md`

---

## File Structure

- **Create** `src/services/roleResolution.ts` — `submitSraKey`, `maybeResolveRoles`, `registerOnResolved`, `_resetOnResolvedForTests`. One responsibility: given a room's accumulated SRA keys in `GMStore`, resolve roles once all are present and notify subscribers.
- **Create** `test/services/roleResolution.test.ts` — unit tests with real SRA crypto + fake redis/store.
- **Modify** `src/routes/eciesRoutes.ts` — `/submit-sra-key` calls `submitSraKey` instead of the inline resolve block.
- **Modify** `src/agents/pregame.ts` — `store?` in deps; `handleReveal` mixed branch injects keys; new `confirmResolvedRoles`.
- **Modify** `test/agents/pregame.test.ts` — mixed scenario.
- **Modify** `src/agents/index.ts` — pass `store` to `PreGameHandler`; `registerOnResolved` → `confirmResolvedRoles`.

---

## Task 1: roleResolution service

**Files:**
- Create: `src/services/roleResolution.ts`
- Test: `test/services/roleResolution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/services/roleResolution.test.ts`:

```typescript
/**
 * roleResolution — shared GM role-resolution unit tests.
 * Real SRA crypto end-to-end; fake redis + real GMStore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateDistributedDeck,
  generateVerifiedSraKeys,
  encryptDeck,
  roleFromCardValue,
} from "../../src/crypto/sra.js";
import {
  submitSraKey,
  registerOnResolved,
  _resetOnResolvedForTests,
  type ResolveCtx,
} from "../../src/services/roleResolution.js";
import { GMStore } from "../../src/stores/index.js";
import { getAgentRole } from "../../src/agents/roles.js";

const CHAIN_ID = 50312;
const ROOM = "8";

class FakeRedis {
  kv = new Map<string, string>();
  async set(k: string, v: string) { this.kv.set(k, v); return "OK" as const; }
  async get(k: string) { return this.kv.has(k) ? this.kv.get(k)! : null; }
  async del(k: string) { return this.kv.delete(k) ? 1 : 0; }
}

const ADDRS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];

/** Deal a 3-player deck, re-encrypt with each player's key. Returns deck + per-addr d. */
function dealMixed() {
  const deck = generateDistributedDeck(
    ADDRS.map(() => ({ isAlive: true })),
    ROOM
  );
  const unique = [...new Set(deck)];
  const keys = ADDRS.map(() => generateVerifiedSraKeys(unique));
  let enc = deck;
  for (const k of keys) enc = encryptDeck(enc, k.e);
  const dByAddr = new Map(ADDRS.map((a, i) => [a.toLowerCase(), keys[i].d.toString()]));
  return { deck, enc, dByAddr };
}

function makeCtx(store: GMStore, redis: FakeRedis, enc: string[]): ResolveCtx {
  return {
    store,
    redis: redis as any,
    chainId: CHAIN_ID,
    roomId: ROOM,
    fetchPlayers: async () => ADDRS.map((wallet) => ({ wallet })),
    fetchDeck: async () => enc,
  };
}

describe("roleResolution.submitSraKey / maybeResolveRoles", () => {
  let store: GMStore;
  let redis: FakeRedis;
  beforeEach(() => {
    store = new GMStore();
    redis = new FakeRedis();
    _resetOnResolvedForTests();
  });

  it("does NOT resolve until every player's key is present", async () => {
    const { enc, dByAddr } = dealMixed();
    const ctx = makeCtx(store, redis, enc);
    const onResolved = vi.fn();
    registerOnResolved(onResolved);

    await submitSraKey(ctx, ADDRS[0], dByAddr.get(ADDRS[0].toLowerCase())!);
    await submitSraKey(ctx, ADDRS[1], dByAddr.get(ADDRS[1].toLowerCase())!);

    const roomKey = store.getRoomKey(CHAIN_ID, ROOM);
    expect(store.resolvedRoles.get(roomKey)?.size ?? 0).toBe(0);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("resolves correct roles + fires onResolved once when the last key arrives", async () => {
    const { deck, enc, dByAddr } = dealMixed();
    const ctx = makeCtx(store, redis, enc);
    const onResolved = vi.fn();
    registerOnResolved(onResolved);

    for (const a of ADDRS) await submitSraKey(ctx, a, dByAddr.get(a.toLowerCase())!);

    const roomKey = store.getRoomKey(CHAIN_ID, ROOM);
    const roles = store.resolvedRoles.get(roomKey)!;
    expect(roles.size).toBe(3);
    ADDRS.forEach((a, i) => {
      expect(roles.get(a.toLowerCase())).toBe(roleFromCardValue(deck[i], ROOM));
    });
    // synced into the agent keyspace
    for (const a of ADDRS) {
      expect(Number(await getAgentRole(redis as any, CHAIN_ID, ROOM, a as `0x${string}`)))
        .toBe(roles.get(a.toLowerCase()));
    }
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(CHAIN_ID, ROOM);
  });

  it("re-submitting after resolution is a no-op (onResolved not re-fired)", async () => {
    const { enc, dByAddr } = dealMixed();
    const ctx = makeCtx(store, redis, enc);
    const onResolved = vi.fn();
    registerOnResolved(onResolved);

    for (const a of ADDRS) await submitSraKey(ctx, a, dByAddr.get(a.toLowerCase())!);
    await submitSraKey(ctx, ADDRS[0], dByAddr.get(ADDRS[0].toLowerCase())!);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/roleResolution.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/roleResolution.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/roleResolution.ts`:

```typescript
/**
 * services/roleResolution.ts — shared GM role resolution.
 *
 * Extracted from routes/eciesRoutes.ts so both the human HTTP path
 * (/submit-sra-key) and the headless agent pre-game (4j mixed) accumulate SRA
 * keys in the same GMStore and resolve roles identically. When the union of all
 * players' keys is present, decrypt the on-chain deck (resolveRolesFromDeck),
 * persist + sync, and fire onResolved so the agent subsystem can confirm agent
 * roles without polling.
 */
import type { RedisClient } from "../redis.js";
import type { GMStore } from "../stores/index.js";
import { Role } from "../types/contract.js";
import { resolveRolesFromDeck } from "../agents/role-resolve.js";
import { syncAgentRolesFromResolvedRoles } from "../agents/role-sync.js";
import { wsManager } from "../ws/wsManager.js";
import { logger } from "../utils/logger.js";

export interface ResolveCtx {
  store: GMStore;
  redis: RedisClient;
  chainId: number;
  roomId: string;
  /** Players in on-chain slot order (slot i = element i). */
  fetchPlayers: () => Promise<readonly { wallet: string }[]>;
  /** Final on-chain revealedDeck. */
  fetchDeck: () => Promise<string[]>;
}

type OnResolvedCb = (chainId: number, roomId: string) => void;
const onResolvedCbs: OnResolvedCb[] = [];

/** Subscribe to "all keys present, roles just resolved" for a room. */
export function registerOnResolved(cb: OnResolvedCb): void {
  onResolvedCbs.push(cb);
}

/** Test helper — clear subscribers between tests. */
export function _resetOnResolvedForTests(): void {
  onResolvedCbs.length = 0;
}

/** Store one player's SRA decryption key, then try to resolve the room. */
export async function submitSraKey(
  ctx: ResolveCtx,
  address: string,
  sraKey: string
): Promise<void> {
  const roomKey = ctx.store.getRoomKey(ctx.chainId, ctx.roomId);
  const addr = address.toLowerCase();
  ctx.store.getRoomMap(ctx.store.sraSKeys, roomKey).set(addr, sraKey);
  if (ctx.redis) {
    const { rPersistSraKey, rPersistRoomChain } = await import("../redis.js");
    rPersistSraKey(ctx.redis, ctx.chainId, ctx.roomId, addr, sraKey);
    rPersistRoomChain(ctx.redis, ctx.chainId, ctx.roomId);
  }
  await maybeResolveRoles(ctx);
}

/** Resolve roles iff every player's key is present. Idempotent; fires onResolved once. */
export async function maybeResolveRoles(ctx: ResolveCtx): Promise<void> {
  const roomKey = ctx.store.getRoomKey(ctx.chainId, ctx.roomId);
  const existing = ctx.store.resolvedRoles.get(roomKey);
  if (existing && existing.size > 0) return; // already resolved

  const roomSra = ctx.store.getRoomMap(ctx.store.sraSKeys, roomKey);
  const players = await ctx.fetchPlayers();
  const addrs = players.map((p) => p.wallet.toLowerCase());
  if (addrs.length === 0 || !addrs.every((a) => roomSra.has(a))) return;

  const deck = await ctx.fetchDeck();
  if (deck.length === 0) return;

  const order = (ctx.store.roomPlayerOrder.get(roomKey) as string[] | undefined) || addrs;
  const allKeys = addrs.map((a) => roomSra.get(a)!).filter(Boolean) as string[];
  const resolved = resolveRolesFromDeck(deck, order, allKeys, ctx.roomId);

  const roomRoles = ctx.store.getRoomMap(ctx.store.resolvedRoles, roomKey);
  for (const [addr, role] of resolved) {
    if (role === Role.NONE) {
      logger.warn({ player: addr, roomId: ctx.roomId }, "[roleResolution] role resolved to NONE");
    }
    roomRoles.set(addr, role);
    if (ctx.redis) {
      const { rPersistRole } = await import("../redis.js");
      rPersistRole(ctx.redis, ctx.chainId, ctx.roomId, addr, role);
    }
  }

  const mafia = [...resolved].filter(([, r]) => r === Role.MAFIA).map(([a]) => a);
  wsManager.setRoomMafia(ctx.roomId, ctx.chainId, mafia);
  if (ctx.redis) {
    await syncAgentRolesFromResolvedRoles(ctx.redis, ctx.chainId, ctx.roomId, roomRoles);
  }
  for (const addr of order) {
    wsManager.sendToPlayer(addr, { type: "role-ready", data: { playerAddress: addr.toLowerCase() } });
  }

  logger.info({ roomId: ctx.roomId, chainId: ctx.chainId, count: resolved.size }, "[roleResolution] roles resolved");
  for (const cb of onResolvedCbs) {
    try {
      cb(ctx.chainId, ctx.roomId);
    } catch (err) {
      logger.error({ err }, "[roleResolution] onResolved callback threw");
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/services/roleResolution.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/roleResolution.ts test/services/roleResolution.test.ts
git commit -m "feat(services): shared roleResolution (submitSraKey + maybeResolveRoles + onResolved hook)"
```

---

## Task 2: eciesRoutes uses the shared service

**Files:**
- Modify: `src/routes/eciesRoutes.ts` (the `/submit-sra-key` handler body, currently the key-store + resolve block)

- [ ] **Step 1: Replace the inline resolve block**

In `src/routes/eciesRoutes.ts`, the `/submit-sra-key` handler currently stores the key then has an inline "all keys present → resolve" block. Replace everything from `const roomKey = store.getRoomKey(...)` down to the end of that resolve block (the `} else if (shufflerAddrs.length > 0) { ... }`) with a single call:

```typescript
      await submitSraKey(
        {
          store,
          redis,
          chainId: Number(chainId),
          roomId: String(roomId),
          fetchPlayers: async () =>
            (await getPlayers(BigInt(roomId), chainId)).map((p) => ({ wallet: p.wallet })),
          fetchDeck: async () => {
            const { public: pc, diamond } = getChainConfig(chainId);
            return (await pc.readContract({
              address: diamond,
              abi: DIAMOND_ABI,
              functionName: "getDeck",
              args: [BigInt(roomId)],
            })) as string[];
          },
        },
        String(playerAddress),
        String(sraKey)
      );

      logger.info({ roomId, player: String(playerAddress).toLowerCase(), chainId }, "[submit-sra-key] SRA key submitted");
      return res.json({ ok: true });
```

Keep the signature-verification block above it unchanged. Add the import at the top of the file:

```typescript
import { submitSraKey } from '../services/roleResolution.js';
```

Remove now-unused imports if the build flags them (`syncAgentRolesFromResolvedRoles`, `wsManager`, `resolveRolesFromDeck` may still be used by other routes in the file — only remove what `tsc` reports as unused; `noUnusedLocals` is off so this is optional cleanup).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Run the full suite (behaviour preserved)**

Run: `npm test`
Expected: all green (same count as before this task).

- [ ] **Step 4: Commit**

```bash
git add src/routes/eciesRoutes.ts
git commit -m "refactor(routes): eciesRoutes /submit-sra-key uses shared roleResolution"
```

---

## Task 3: PreGameHandler — store, mixed inject branch, confirmResolvedRoles

**Files:**
- Modify: `src/agents/pregame.ts`
- Test: `test/agents/pregame.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/agents/pregame.test.ts` (inside the file; it already has `FakeChain`, `FakeRedis`, `agentAddrs`, `buildHandler`, `evt`, `GamePhase`, `FLAGS`, crypto imports). Add these imports at the top if missing:

```typescript
import { GMStore } from "../../src/stores/index.js";
import {
  submitSraKey,
  registerOnResolved,
  _resetOnResolvedForTests,
} from "../../src/services/roleResolution.js";
import {
  generateDistributedDeck,
  generateVerifiedSraKeys,
  encryptDeck,
} from "../../src/crypto/sra.js";
```

Then add this describe block:

```typescript
describe("PreGameHandler.handleReveal — mixed (human present)", () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    _resetOnResolvedForTests();
  });

  it("injects agent keys, then confirms via onResolved when the human's key lands", async () => {
    // 3 agents + 1 human. Build a real 4-card deck encrypted by all 4 keys.
    const agents = agentAddrs(3);
    const human = "0x9999999999999999999999999999999999999999" as Address;
    const players = [...agents, human];

    const deck = generateDistributedDeck(players.map(() => ({ isAlive: true })), ROOM_ID.toString());
    const unique = [...new Set(deck)];
    const keys = players.map(() => generateVerifiedSraKeys(unique));
    let enc = deck;
    for (const k of keys) enc = encryptDeck(enc, k.e);

    // Seed each AGENT's SRA key into redis (as handleShuffling would have).
    agents.forEach((a, i) => {
      redis.store.set(
        agentSraKey(CHAIN_ID, ROOM_ID.toString(), a),
        { value: JSON.stringify({ e: keys[i].e.toString(), d: keys[i].d.toString() }), expiresAt: null }
      );
    });
    const humanD = keys[3].d.toString();

    // Fake chain in REVEAL with the encrypted deck on-chain; only agents are agents.
    const chain = new FakeChain(players, {
      phase: GamePhase.REVEAL,
      agentSet: new Set(agents.map((a) => a.toLowerCase())),
    });
    chain.revealedDeck = enc;

    const store = new GMStore();
    const handler = buildHandler(redis, chain, { store });
    registerOnResolved((cid, rid) => {
      void handler.confirmResolvedRoles(cid, rid);
    });

    // 1. handleReveal injects agent keys but can't resolve yet (human missing).
    await handler.handleReveal(evt);
    const roomKey = store.getRoomKey(CHAIN_ID, ROOM_ID.toString());
    expect(store.getRoomMap(store.sraSKeys, roomKey).size).toBe(3);
    expect(chain.confirmRoleCalls).toHaveLength(0);

    // 2. Human submits via the shared service → resolve → onResolved → agents confirm.
    await submitSraKey(
      {
        store,
        redis: redis as any,
        chainId: CHAIN_ID,
        roomId: ROOM_ID.toString(),
        fetchPlayers: async () => players.map((wallet) => ({ wallet })),
        fetchDeck: async () => enc,
      },
      human,
      humanD
    );
    // confirmResolvedRoles is fire-and-forget inside the hook; await a tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(chain.confirmRoleCalls).toHaveLength(3); // the 3 agents confirmed
    expect(chain.phase).toBe(GamePhase.REVEAL); // human not yet confirmed → not DAY
  });

  it("returns resolve-failed when no store is configured (degraded)", async () => {
    const agents = agentAddrs(3);
    const human = "0x9999999999999999999999999999999999999999" as Address;
    const chain = new FakeChain([...agents, human], {
      phase: GamePhase.REVEAL,
      agentSet: new Set(agents.map((a) => a.toLowerCase())),
    });
    chain.revealedDeck = ["x", "x", "x", "x"];
    const handler = buildHandler(redis, chain); // no store
    const out = await handler.handleReveal(evt);
    expect(out.every((o) => o.status === "resolve-failed")).toBe(true);
  });
});
```

Note: `buildHandler` must accept `store`. The existing `buildHandler(redis, chain, over)` spreads `over` into the deps, so `{ store }` flows through once `PreGameHandlerDeps` has a `store` field.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/pregame.test.ts`
Expected: FAIL — `handler.confirmResolvedRoles is not a function` (and/or `store` typing).

- [ ] **Step 3: Implement in `src/agents/pregame.ts`**

3a. Add imports at the top:

```typescript
import type { GMStore } from "../stores/index.js";
import { submitSraKey } from "../services/roleResolution.js";
```

3b. Add `store` to `PreGameHandlerDeps`:

```typescript
  /** GM in-memory store. Required for mixed (human+agent) role resolution; without
   *  it the mixed REVEAL branch degrades to resolve-failed. */
  store?: GMStore;
```

3c. In `handleReveal`, replace the missing-keys early return:

```typescript
    if (missing.length > 0) {
      // MIXED game (humans present): we don't hold every key. Inject our agents'
      // keys into the shared GM resolution; the human submits theirs via HTTP.
      // When all are present, roleResolution fires onResolved -> confirmResolvedRoles.
      if (!this.deps.store) {
        log.error({ missing }, "[pregame] mixed game but no GMStore configured — cannot resolve");
        return myAgents.map((w) => ({ agent: w.address, status: "resolve-failed" as const }));
      }
      const store = this.deps.store;
      const outcomes: RevealOutcome[] = [];
      for (const w of myAgents) {
        const k = await this.loadSraKeys(chain.chainId, roomIdStr, w.address);
        if (!k) {
          outcomes.push({ agent: w.address, status: "resolve-failed" });
          continue;
        }
        try {
          await submitSraKey(
            {
              store,
              redis: this.deps.redis as any,
              chainId: chain.chainId,
              roomId: roomIdStr,
              fetchPlayers: async () => (await chain.getPlayers(roomId)).map((p) => ({ wallet: p.wallet })),
              fetchDeck: async () => chain.getDeck(roomId),
            },
            w.address,
            k.d.toString()
          );
          outcomes.push({ agent: w.address, status: "key-injected" });
        } catch (err: any) {
          log.error({ err: String(err?.message ?? err), agent: w.address }, "[pregame] submitSraKey failed");
          outcomes.push({ agent: w.address, status: "failed", err: String(err?.message ?? err) });
        }
      }
      log.info({ outcomes: outcomes.map((o) => o.status) }, "[pregame] mixed: agent keys injected; confirm via onResolved");
      return outcomes;
    }
```

3d. Add `"key-injected"` to the `RevealStatus` union:

```typescript
export type RevealStatus =
  | "confirmed"
  | "key-injected"
  | "skipped-already-confirmed"
  | "resolve-failed"
  | "failed";
```

3e. Add the `confirmResolvedRoles` method to the `PreGameHandler` class (after `handleReveal`):

```typescript
  /**
   * Confirm role for each of our agents whose role is resolved in the GM store
   * and not yet confirmed on chain. Invoked by the roleResolution onResolved hook
   * (mixed games). Fire-and-forget; idempotent via FLAG_CONFIRMED_ROLE + revert.
   */
  async confirmResolvedRoles(chainId: number, roomId: string): Promise<RevealOutcome[]> {
    if (!this.deps.store) return [];
    const chain = this.deps.chainOpsFor(chainId);
    const roomIdBig = BigInt(roomId);
    const log = logger.child({ mod: "agents/pregame", chainId, roomId, phase: "REVEAL-confirm" });

    const room = await chain.getRoom(roomIdBig).catch(() => null);
    if (!room || room.phase !== GamePhase.REVEAL) return [];

    const players = await chain.getPlayers(roomIdBig);
    const myByAddr = await this.resolveMyAgents(chain, roomIdBig, players);
    if (myByAddr.size === 0) return [];

    const roomKey = this.deps.store.getRoomKey(chainId, roomId);
    const resolved = this.deps.store.resolvedRoles.get(roomKey);
    if (!resolved || resolved.size === 0) return [];

    const flagsByAddr = new Map(players.map((p) => [p.wallet.toLowerCase(), p.flags]));
    return Promise.all(
      [...myByAddr.values()].map((w) =>
        this.doConfirmRole({
          chain,
          roomId: roomIdBig,
          roomIdStr: roomId,
          wallet: w,
          role: (resolved.get(w.address.toLowerCase()) ?? Role.NONE) as Role,
          alreadyConfirmed: ((flagsByAddr.get(w.address.toLowerCase()) ?? 0) & FLAGS.CONFIRMED_ROLE) !== 0,
          log,
        }).catch((err) => ({
          agent: w.address,
          status: "failed" as const,
          err: String(err?.message ?? err),
        }))
      )
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/pregame.test.ts`
Expected: PASS (existing all-agent tests + 2 new mixed tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/pregame.ts test/agents/pregame.test.ts
git commit -m "feat(agents): PreGameHandler mixed REVEAL — inject keys + confirmResolvedRoles hook"
```

---

## Task 4: Wire PreGameHandler store + onResolved in index.ts

**Files:**
- Modify: `src/agents/index.ts`

- [ ] **Step 1: Add the import**

At the top of `src/agents/index.ts`:

```typescript
import { registerOnResolved } from "../services/roleResolution.js";
```

- [ ] **Step 2: Pass store + register the hook**

Find the `const preGameHandler = new PreGameHandler({ ... })` block. Add `store` to its deps:

```typescript
  const preGameHandler = new PreGameHandler({
    redis,
    chainOpsFor: (chainId: number) => {
      const ops = preGameOpsCache.get(chainId);
      if (!ops) throw new Error(`[agents] no preGameChainOps for chainId ${chainId}`);
      return ops;
    },
    mnemonic,
    txGasPriceGwei: Number(process.env.TX_GAS_PRICE_GWEI ?? "10"),
    shareKeysOnChain: (process.env.AGENTS_SHARE_KEYS_ONCHAIN ?? "").toLowerCase() === "true",
    store,
  });

  // Mixed games: when the GM resolves roles (after the human submits the last
  // SRA key), confirm our agents' roles. Fire-and-forget — must not block the
  // HTTP path or the event listener.
  registerOnResolved((chainId, roomId) => {
    preGameHandler
      .confirmResolvedRoles(chainId, roomId)
      .catch((err) => logger.error({ err, chainId, roomId }, "[agents] confirmResolvedRoles threw"));
  });
```

(`store` is the `startAgentSubsystem(store?: GMStore)` parameter. If `store` is `undefined` at boot, `PreGameHandler` simply degrades on mixed games — acceptable; production always passes it from `src/index.ts`.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/index.ts
git commit -m "feat(agents): wire PreGameHandler store + onResolved -> confirmResolvedRoles"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full build + suite**

Run: `npm run build && npm test`
Expected: build clean; all tests green (previous total + 3 roleResolution + 2 pregame mixed = +5).

- [ ] **Step 2: Manual sanity (no chain) — confirm wiring shape**

Confirm by reading that:
- `src/index.ts` passes the same `store` to `createEciesRoutes` and `startAgentSubsystem(store)` (unchanged — verified in spec).
- `eciesRoutes` and `PreGameHandler` both call `submitSraKey` from the same `roleResolution` module (shared `onResolvedCbs`).

- [ ] **Step 3: Live (real proof, operator-run)**

With `.env` (mnemonic, sponsor funded, GM key, RPC) and Redis up, run the gm-server `AGENTS_ENABLED=true`. In the browser: create a room → "Add agents" (`/agents/fill-room`, 3 agents) → Start → play. Expected: REVEAL resolves (your `/my-role` returns; agents confirm), game reaches DAY and proceeds.

---

## Self-Review notes (already applied)

- **Spec coverage:** §3 service → Task 1; §3 eciesRoutes refactor → Task 2; §4 mixed branch + confirmResolvedRoles + no-poll hook → Task 3; §5 index wiring + registerOnResolved → Task 4; §8 tests → Tasks 1 & 3.
- **Type consistency:** `submitSraKey(ctx, address, sraKey)`, `ResolveCtx`, `registerOnResolved`, `confirmResolvedRoles(chainId, roomId)`, `RevealStatus` adds `"key-injected"` — used consistently across tasks.
- **No placeholders:** all steps contain full code/commands.

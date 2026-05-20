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

/**
 * PreGameHandler — SHUFFLING + REVEAL unit tests (4j phase 2/3).
 *
 * The handler drives an all-agent room through the pre-game the browser used to
 * do per-human: sequential deck commit/reveal (SHUFFLING) then server-direct
 * role resolution + role commit (REVEAL), reaching DAY.
 *
 * `FakeChain` is a faithful in-memory model of ShuffleFacet's state machine so
 * the test proves the handler drives a contract-accurate sequence to DAY:
 *   - commitDeck   → sets DECK_COMMITTED, stores commitHash, turn-gated
 *   - revealDeck   → verifies keccak256(abi.encode(deck,salt)), advances
 *                    currentShufflerIndex, → REVEAL when past the last player
 *   - commitAndConfirmRole → sets CONFIRMED_ROLE, → DAY when all confirmed
 * Crypto is REAL: the handler builds real SRA-encrypted decks and persists real
 * keys, the fake stores the real revealed deck, so resolveRolesFromDeck actually
 * decrypts the dealt roles.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { createECDH } from "node:crypto";

import {
  PreGameHandler,
  type PreGameChainOps,
  type RoomPregameSnapshot,
  type PlayerPregameSnapshot,
} from "../../src/agents/pregame.js";
import { deriveAgentWallets } from "../../src/agents/wallets.js";
import { agentSraKey, agentRoleSaltKey } from "../../src/agents/redis-keys.js";
import { getAgentRole } from "../../src/agents/roles.js";
import { Role, GamePhase, FLAGS } from "../../src/types/contract.js";
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

// ─── In-memory Redis fake (mirrors voting.test.ts) ─────────────────────────
class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, ...args: any[]): Promise<"OK" | null> {
    let nx = false;
    let ex: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "NX") nx = true;
      if (a === "EX") ex = Number(args[i + 1]);
    }
    const ex0 = this.store.get(key);
    const now = Date.now();
    const alive = ex0 && (ex0.expiresAt == null || ex0.expiresAt > now);
    if (nx && alive) return null;
    this.store.set(key, { value, expiresAt: ex != null ? now + ex * 1000 : null });
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

// ─── Constants ─────────────────────────────────────────────────────────────
const CHAIN_ID = 50312;
const DIAMOND: Hex = "0x031b6746155ce11c7b533935f4674f5fc4682338";
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const ROOM_ID = 9n;

function p256Pubkey(): Hex {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ("0x" + ecdh.getPublicKey("hex", "uncompressed")) as Hex;
}

function deckCommitHashLocal(deck: string[], salt: string): Hex {
  const clean = salt.startsWith("0x") ? salt.slice(2) : salt;
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string[], string"), [deck, clean])
  );
}

/**
 * Faithful in-memory ShuffleFacet model for one room. All players active/alive.
 */
class FakeChain implements PreGameChainOps {
  readonly chainId = CHAIN_ID;
  readonly diamond = DIAMOND;
  phase: GamePhase;
  currentShufflerIndex = 0;
  revealedDeck: string[] = [];
  revealedCount = 0;
  confirmedCount = 0;
  keysSharedCount = 0;
  flags: number[];
  deckCommit: (Hex | null)[];
  roleCommit: (Hex | null)[];
  readonly players: PlayerPregameSnapshot[];
  agentSet: Set<string>;

  // spies
  commitDeckCalls = 0;
  revealDeckCalls = 0;
  shareKeysCalls: { agent: Address; recipients: Address[] }[] = [];
  confirmRoleCalls: { agent: Address; roleHash: Hex }[] = [];

  constructor(addrs: Address[], opts: { phase?: GamePhase; agentSet?: Set<string> } = {}) {
    this.players = addrs.map((a) => ({
      wallet: a,
      flags: FLAGS.ACTIVE,
      publicKey: p256Pubkey(),
    }));
    this.flags = addrs.map(() => FLAGS.ACTIVE);
    this.deckCommit = addrs.map(() => null);
    this.roleCommit = addrs.map(() => null);
    this.phase = opts.phase ?? GamePhase.SHUFFLING;
    this.agentSet =
      opts.agentSet ?? new Set(addrs.map((a) => a.toLowerCase()));
  }

  private idxOf(addr: Address): number {
    return this.players.findIndex(
      (p) => p.wallet.toLowerCase() === addr.toLowerCase()
    );
  }
  private get aliveCount(): number {
    return this.flags.filter((f) => (f & FLAGS.ACTIVE) !== 0).length;
  }

  async getRoom(): Promise<RoomPregameSnapshot> {
    return {
      phase: this.phase,
      playersCount: this.players.length,
      aliveCount: this.aliveCount,
      currentShufflerIndex: this.currentShufflerIndex,
      confirmedCount: this.confirmedCount,
      keysSharedCount: this.keysSharedCount,
      revealedCount: this.revealedCount,
      phaseDeadline: Math.floor(Date.now() / 1000) + 180,
    };
  }
  async getPlayers(): Promise<readonly PlayerPregameSnapshot[]> {
    return this.players.map((p, i) => ({ ...p, flags: this.flags[i] }));
  }
  async getDeck(): Promise<string[]> {
    return this.revealedDeck;
  }
  async isAgent(_roomId: bigint, addr: Address): Promise<boolean> {
    return this.agentSet.has(addr.toLowerCase());
  }

  async sendStartGame(): Promise<Hex> {
    this.phase = GamePhase.SHUFFLING;
    return "0xstart";
  }

  async sendCommitDeck(agent: any, _roomId: bigint, deckHash: Hex): Promise<Hex> {
    this.commitDeckCalls++;
    const i = this.idxOf(agent.address);
    if (this.phase !== GamePhase.SHUFFLING) throw new Error("WrongPhase");
    if (this.players[this.currentShufflerIndex].wallet.toLowerCase() !== agent.address.toLowerCase())
      throw new Error("NotYourTurn");
    if ((this.flags[i] & FLAGS.DECK_COMMITTED) !== 0) throw new Error("AlreadyCommitted");
    this.deckCommit[i] = deckHash;
    this.flags[i] |= FLAGS.DECK_COMMITTED;
    return ("0xcommit" + i) as Hex;
  }

  async sendRevealDeck(agent: any, _roomId: bigint, deck: string[], salt: string): Promise<Hex> {
    this.revealDeckCalls++;
    const i = this.idxOf(agent.address);
    if (this.phase !== GamePhase.SHUFFLING) throw new Error("WrongPhase");
    if (deckCommitHashLocal(deck, salt) !== this.deckCommit[i]) throw new Error("InvalidReveal");
    if (this.revealedDeck.length === 0 && deck.length < this.players.length)
      throw new Error("InvalidDeckSize");
    if (this.revealedDeck.length !== 0 && deck.length !== this.revealedDeck.length)
      throw new Error("InvalidDeckSize");
    this.revealedDeck = deck;
    this.revealedCount++;
    // findNextActive(currentShufflerIndex + 1)
    let next = this.currentShufflerIndex + 1;
    while (next < this.players.length && (this.flags[next] & FLAGS.ACTIVE) === 0) next++;
    this.currentShufflerIndex = next;
    if (next >= this.players.length) this.phase = GamePhase.REVEAL;
    return ("0xreveal" + i) as Hex;
  }

  async sendShareKeys(agent: any, _roomId: bigint, recipients: Address[], encryptedKeys: Hex[]): Promise<Hex> {
    const i = this.idxOf(agent.address);
    if (this.phase !== GamePhase.REVEAL) throw new Error("WrongPhase");
    if (recipients.length !== encryptedKeys.length) throw new Error("InvalidArrayLength");
    if (recipients.some((r) => r.toLowerCase() === agent.address.toLowerCase()))
      throw new Error("InvalidSessionAddress"); // contract: cannot include self
    if ((this.flags[i] & FLAGS.HAS_SHARED_KEYS) !== 0) throw new Error("AlreadySharedKeys");
    this.flags[i] |= FLAGS.HAS_SHARED_KEYS;
    this.keysSharedCount++;
    this.shareKeysCalls.push({ agent: agent.address, recipients });
    return ("0xshare" + i) as Hex;
  }

  async sendCommitAndConfirmRole(agent: any, _roomId: bigint, roleHash: Hex): Promise<Hex> {
    const i = this.idxOf(agent.address);
    if (this.phase !== GamePhase.REVEAL) throw new Error("WrongPhase");
    if (this.roleCommit[i] !== null) throw new Error("RoleAlreadyCommitted");
    if ((this.flags[i] & FLAGS.CONFIRMED_ROLE) !== 0) throw new Error("AlreadyRevealed");
    this.roleCommit[i] = roleHash;
    this.flags[i] |= FLAGS.CONFIRMED_ROLE;
    this.confirmedCount++;
    this.confirmRoleCalls.push({ agent: agent.address, roleHash });
    if (this.confirmedCount === this.aliveCount) this.phase = GamePhase.DAY;
    return ("0xrole" + i) as Hex;
  }
}

function agentAddrs(count: number): Address[] {
  return deriveAgentWallets(TEST_MNEMONIC, ROOM_ID, count).map((w) => w.address);
}

function buildHandler(redis: FakeRedis, chain: PreGameChainOps, over: any = {}) {
  return new PreGameHandler({
    redis: redis as any,
    chainOpsFor: () => chain,
    mnemonic: TEST_MNEMONIC,
    maxAgentsPerRoom: 8,
    txGasPriceGwei: 5,
    ...over,
  });
}

const evt = { chainId: CHAIN_ID, roomId: ROOM_ID.toString() };

// ─── SHUFFLING ──────────────────────────────────────────────────────────────
describe("PreGameHandler.handleShuffling", () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
  });

  it("drives all-agent room through every shuffle turn → REVEAL", async () => {
    const addrs = agentAddrs(6);
    const chain = new FakeChain(addrs);
    const handler = buildHandler(redis, chain);

    const outcomes = await handler.handleShuffling(evt);

    expect(chain.commitDeckCalls).toBe(6);
    expect(chain.revealDeckCalls).toBe(6);
    expect(chain.phase).toBe(GamePhase.REVEAL);
    expect(chain.revealedDeck).toHaveLength(6);
    expect(outcomes.filter((o) => o.status === "shuffled")).toHaveLength(6);

    // SRA keys persisted for every agent (restart resilience).
    for (const a of addrs) {
      const raw = await redis.get(agentSraKey(CHAIN_ID, ROOM_ID.toString(), a));
      expect(raw).not.toBeNull();
      const { e, d } = JSON.parse(raw!);
      expect(BigInt(e)).toBeGreaterThan(0n);
      expect(BigInt(d)).toBeGreaterThan(0n);
    }
  });

  it("first shuffler deals a full-length deck; each commit hash matches its reveal", async () => {
    const addrs = agentAddrs(5);
    const chain = new FakeChain(addrs);
    // Capture (deckHash committed) vs (deck,salt revealed) to assert binding.
    const committed: Hex[] = [];
    const origCommit = chain.sendCommitDeck.bind(chain);
    chain.sendCommitDeck = async (agent, roomId, deckHash) => {
      committed.push(deckHash);
      return origCommit(agent, roomId, deckHash);
    };
    const revealed: { deck: string[]; salt: string }[] = [];
    const origReveal = chain.sendRevealDeck.bind(chain);
    chain.sendRevealDeck = async (agent, roomId, deck, salt) => {
      revealed.push({ deck, salt });
      return origReveal(agent, roomId, deck, salt);
    };

    await handler_handleShuffling(redis, chain);

    expect(revealed[0].deck).toHaveLength(5); // first deals full deck
    committed.forEach((h, i) =>
      expect(deckCommitHashLocal(revealed[i].deck, revealed[i].salt)).toBe(h)
    );
  });

  it("returns empty when room is not in SHUFFLING phase", async () => {
    const chain = new FakeChain(agentAddrs(4), { phase: GamePhase.DAY });
    const handler = buildHandler(redis, chain);
    expect(await handler.handleShuffling(evt)).toEqual([]);
    expect(chain.commitDeckCalls).toBe(0);
  });

  it("recovers a committed-but-not-revealed turn with only revealDeck", async () => {
    const addrs = agentAddrs(3);
    const chain = new FakeChain(addrs);
    const handler = buildHandler(redis, chain);

    // First pass: let agent 0 commit, then make reveal blow up so the loop aborts
    // after the deck+salt were persisted but before the on-chain reveal landed.
    const origReveal = chain.sendRevealDeck.bind(chain);
    let failOnce = true;
    chain.sendRevealDeck = async (agent, roomId, deck, salt) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("boom");
      }
      return origReveal(agent, roomId, deck, salt);
    };

    await handler.handleShuffling(evt); // agent 0 commits, reveal throws → stuck
    expect(chain.commitDeckCalls).toBe(1);
    expect((chain.flags[0] & FLAGS.DECK_COMMITTED) !== 0).toBe(true);
    expect(chain.currentShufflerIndex).toBe(0); // not advanced

    const before = chain.commitDeckCalls;
    await handler.handleShuffling(evt); // recovery: reveal-only for agent 0, then finish
    expect(chain.commitDeckCalls).toBe(before + 2); // agents 1 & 2 commit; agent 0 NOT re-committed
    expect(chain.phase).toBe(GamePhase.REVEAL);
  });

  it("stops at a human (non-agent) current shuffler without crashing", async () => {
    const addrs = agentAddrs(4);
    const human = addrs[2];
    const chain = new FakeChain(addrs, {
      agentSet: new Set([
        addrs[0].toLowerCase(),
        addrs[1].toLowerCase(),
        addrs[3].toLowerCase(),
      ]),
    });
    const handler = buildHandler(redis, chain);
    await handler.handleShuffling(evt);
    // agents 0,1 take their turns then idx points at the human → stop
    expect(chain.currentShufflerIndex).toBe(2);
    expect(chain.commitDeckCalls).toBe(2);
    expect(chain.phase).toBe(GamePhase.SHUFFLING);
    void human;
  });
});

async function handler_handleShuffling(redis: FakeRedis, chain: PreGameChainOps) {
  const handler = buildHandler(redis, chain);
  return handler.handleShuffling(evt);
}

// ─── REVEAL ───────────────────────────────────────────────────────────────
describe("PreGameHandler.handleReveal", () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
  });

  async function shuffleThenReveal(count: number, over: any = {}) {
    const addrs = agentAddrs(count);
    const chain = new FakeChain(addrs);
    const handler = buildHandler(redis, chain, over);
    await handler.handleShuffling(evt);
    const outcomes = await handler.handleReveal(evt);
    return { addrs, chain, handler, outcomes };
  }

  it("resolves roles server-direct and confirms every agent → DAY", async () => {
    const { addrs, chain, outcomes } = await shuffleThenReveal(6);

    expect(chain.confirmRoleCalls).toHaveLength(6);
    expect(chain.phase).toBe(GamePhase.DAY);
    expect(outcomes.filter((o) => o.status === "confirmed")).toHaveLength(6);

    // Role distribution for 6 alive: 2 mafia, 1 doctor, 1 detective, 2 citizen.
    const roleIds = outcomes.map((o) => o.roleId);
    const count = (r: Role) => roleIds.filter((x) => x === r).length;
    expect(count(Role.MAFIA)).toBe(2);
    expect(count(Role.DOCTOR)).toBe(1);
    expect(count(Role.DETECTIVE)).toBe(1);
    expect(count(Role.CITIZEN)).toBe(2);

    // Each confirmed roleHash binds the resolved role + persisted salt.
    for (const o of outcomes) {
      const salt = await redis.get(agentRoleSaltKey(CHAIN_ID, ROOM_ID.toString(), o.agent));
      expect(salt).not.toBeNull();
      const expectedHash = keccak256(
        encodeAbiParameters(parseAbiParameters("uint256, string"), [
          BigInt(o.roleId!),
          salt!,
        ])
      );
      const call = chain.confirmRoleCalls.find(
        (c) => c.agent.toLowerCase() === o.agent.toLowerCase()
      );
      expect(call!.roleHash).toBe(expectedHash);
    }

    // Roles synced into the agent keyspace for the DAY/NIGHT loop.
    for (const o of outcomes) {
      const stored = await getAgentRole(redis as any, CHAIN_ID, ROOM_ID.toString(), o.agent);
      expect(Number(stored)).toBe(o.roleId);
    }
    void addrs;
  });

  it("returns empty when room is not in REVEAL phase", async () => {
    const chain = new FakeChain(agentAddrs(4), { phase: GamePhase.SHUFFLING });
    const handler = buildHandler(redis, chain);
    expect(await handler.handleReveal(evt)).toEqual([]);
    expect(chain.confirmRoleCalls).toHaveLength(0);
  });

  it("skips an agent that already confirmed its role (idempotent)", async () => {
    const { chain, handler, outcomes } = await shuffleThenReveal(5);
    expect(outcomes.filter((o) => o.status === "confirmed")).toHaveLength(5);
    expect(chain.phase).toBe(GamePhase.DAY);

    // A second reveal pass: phase is now DAY → empty, but force REVEAL to prove
    // the flag guard (no double commit).
    chain.phase = GamePhase.REVEAL;
    const again = await handler.handleReveal(evt);
    expect(again.every((o) => o.status === "skipped-already-confirmed")).toBe(true);
    expect(chain.confirmRoleCalls).toHaveLength(5); // not incremented
  });

  it("reuses the persisted role salt across calls (stable roleHash)", async () => {
    const { chain, handler, addrs } = await shuffleThenReveal(4);
    const first = chain.confirmRoleCalls.find(
      (c) => c.agent.toLowerCase() === addrs[0].toLowerCase()
    )!.roleHash;
    const saltBefore = await redis.get(agentRoleSaltKey(CHAIN_ID, ROOM_ID.toString(), addrs[0]));

    // Re-run reveal (flags already confirmed → skipped) — salt must be untouched.
    chain.phase = GamePhase.REVEAL;
    await handler.handleReveal(evt);
    const saltAfter = await redis.get(agentRoleSaltKey(CHAIN_ID, ROOM_ID.toString(), addrs[0]));
    expect(saltAfter).toBe(saltBefore);
    void first;
  });

  it("when shareKeysOnChain is enabled, shares keys excluding self", async () => {
    const addrs = agentAddrs(4);
    const chain = new FakeChain(addrs);
    const handler = buildHandler(redis, chain, { shareKeysOnChain: true });
    await handler.handleShuffling(evt);
    await handler.handleReveal(evt);

    expect(chain.shareKeysCalls).toHaveLength(4);
    for (const call of chain.shareKeysCalls) {
      expect(call.recipients).toHaveLength(3); // 4 players minus self
      expect(
        call.recipients.some((r) => r.toLowerCase() === call.agent.toLowerCase())
      ).toBe(false);
    }
  });
});

// ─── MIXED (human present) REVEAL ──────────────────────────────────────────
describe("PreGameHandler.handleReveal — mixed (human present)", () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    _resetOnResolvedForTests();
  });

  it("injects agent keys, then confirms via onResolved when the human's key lands", async () => {
    const agents = agentAddrs(3);
    const human = "0x9999999999999999999999999999999999999999" as Address;
    const players = [...agents, human];

    const deck = generateDistributedDeck(players.map(() => ({ isAlive: true })), ROOM_ID.toString());
    const unique = [...new Set(deck)];
    const keys = players.map(() => generateVerifiedSraKeys(unique));
    let enc = deck;
    for (const k of keys) enc = encryptDeck(enc, k.e);

    agents.forEach((a, i) => {
      redis.store.set(
        agentSraKey(CHAIN_ID, ROOM_ID.toString(), a),
        { value: JSON.stringify({ e: keys[i].e.toString(), d: keys[i].d.toString() }), expiresAt: null }
      );
    });
    const humanD = keys[3].d.toString();

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

    await handler.handleReveal(evt);
    const roomKey = store.getRoomKey(CHAIN_ID, ROOM_ID.toString());
    expect(store.getRoomMap(store.sraSKeys, roomKey).size).toBe(3);
    expect(chain.confirmRoleCalls).toHaveLength(0);

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
    await new Promise((r) => setTimeout(r, 0));

    expect(chain.confirmRoleCalls).toHaveLength(3);
    expect(chain.phase).toBe(GamePhase.REVEAL);
  });

  it("returns resolve-failed when no store is configured (degraded)", async () => {
    const agents = agentAddrs(3);
    const human = "0x9999999999999999999999999999999999999999" as Address;
    const chain = new FakeChain([...agents, human], {
      phase: GamePhase.REVEAL,
      agentSet: new Set(agents.map((a) => a.toLowerCase())),
    });
    chain.revealedDeck = ["x", "x", "x", "x"];
    const handler = buildHandler(redis, chain);
    const out = await handler.handleReveal(evt);
    expect(out.every((o) => o.status === "resolve-failed")).toBe(true);
  });
});

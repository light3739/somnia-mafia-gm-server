/**
 * Unit tests for DayHandler. Pure in-process — no chain, no LLM, no Redis
 * server. Every external surface is faked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Address, Hex, HDAccount, PublicClient, WalletClient } from "viem";

import {
  DayHandler,
  type DayChainOps,
  type DayStartedEvent,
  type DayBroadcaster,
  type InferChatFn,
  type RoomSnapshot,
  type PlayerSnapshot,
} from "../../src/agents/day.js";
import {
  agentActionProcessedKey,
  agentChatPromptKey,
  agentMessageCommittedKey,
  agentSkipReasonKey,
  agentTraceKey,
} from "../../src/agents/redis-keys.js";
import { setAgentRole, AgentRole } from "../../src/agents/roles.js";
import { computeMessageHash, makePhaseId, MSG_KIND_REGULAR, SCRUB_VERSION } from "../../src/agents/trace.js";

const PHASE_DAY = 3; // GamePhase.DAY (contract enum)
const PHASE_NIGHT = 5;
const FLAG_ACTIVE = 0x2;
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Use the SAME mnemonic that the handler uses for deterministic agent derivation in tests.
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

// ─── In-memory Redis fake (covers all ops the handler uses) ────────────────
class FakeRedis {
  private kv = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();

  async set(key: string, value: string, ...args: any[]): Promise<"OK" | null> {
    let nx = false;
    let exSeconds: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "NX") nx = true;
      if (a === "EX") exSeconds = Number(args[i + 1]);
    }
    if (nx && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.kv.has(key) ? this.kv.get(key)! : null;
  }
  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
  async rpush(key: string, value: string): Promise<number> {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    l.push(value);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key);
    if (!l) return [];
    const len = l.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? len + stop : stop;
    return l.slice(s, e + 1);
  }
  async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
    const l = this.lists.get(key);
    if (!l) return "OK";
    const len = l.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? len + stop : stop;
    this.lists.set(key, l.slice(s, e + 1));
    return "OK";
  }
  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }
  async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }
  async sadd(key: string, member: string): Promise<number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    if (s.has(member)) return 0;
    s.add(member);
    return 1;
  }
}

// ─── Helper: agent addresses derived from TEST_MNEMONIC ────────────────────
import { mnemonicToAccount } from "viem/accounts";
function deriveAgent(roomId: bigint, idx: number) {
  const bucket = Number(BigInt(roomId) & 0x7fffffffn);
  return mnemonicToAccount(TEST_MNEMONIC, {
    accountIndex: 0,
    changeIndex: bucket,
    addressIndex: idx,
  });
}

// ─── Fake chain ops ────────────────────────────────────────────────────────
interface FakeChainOpts {
  alive: Address[];
  agentAddrs: Address[];
  phaseSequence?: number[]; // sequence of phase values returned by successive getRoom calls
  preCommittedHash?: Hex; // if set, getAgentMessageHash returns this on first call
  storedAfterFailure?: Hex; // value getAgentMessageHash returns AFTER sendCommitMessageV2 throws
  sendCommitThrows?: boolean;
  sponsorWei?: bigint;
}

function makeChain(opts: FakeChainOpts): DayChainOps & {
  sendCommitCalls: Hex[];
  getMessageHashCalls: number;
  roomCalls: number;
} {
  let roomCallIndex = 0;
  const sendCommitCalls: Hex[] = [];
  let getMessageHashCalls = 0;
  const obj: any = {
    chainId: 50312,
    diamond: "0x031b6746155ce11c7b533935f4674f5fc4682338" as Hex,
    publicClient: {} as PublicClient,
    sendCommitCalls,
    get getMessageHashCalls() {
      return getMessageHashCalls;
    },
    get roomCalls() {
      return roomCallIndex;
    },
    async getRoom(_roomId: bigint): Promise<RoomSnapshot> {
      const phase =
        opts.phaseSequence?.[Math.min(roomCallIndex, opts.phaseSequence.length - 1)] ??
        PHASE_DAY;
      roomCallIndex += 1;
      return { phase, dayCount: 1, aliveCount: opts.alive.length };
    },
    async getPlayers(_roomId: bigint): Promise<readonly PlayerSnapshot[]> {
      return opts.alive.map((wallet) => ({ wallet, flags: FLAG_ACTIVE }));
    },
    async isAgent(_roomId: bigint, addr: Address): Promise<boolean> {
      return opts.agentAddrs.some(
        (a) => a.toLowerCase() === addr.toLowerCase()
      );
    },
    async getAgentMessageHash(
      _roomId: bigint,
      _phaseId: Hex,
      _agent: Address
    ): Promise<Hex> {
      getMessageHashCalls += 1;
      // First call is the pre-check; later calls are recovery probes.
      if (getMessageHashCalls === 1 && opts.preCommittedHash) {
        return opts.preCommittedHash;
      }
      if (getMessageHashCalls > 1 && opts.storedAfterFailure) {
        return opts.storedAfterFailure;
      }
      return ZERO_BYTES32;
    },
    async sendCommitMessageV2(
      _agent: HDAccount,
      _roomId: bigint,
      _phaseId: Hex,
      messageHash: Hex,
      _gasPriceGwei: number
    ): Promise<Hex> {
      if (opts.sendCommitThrows) {
        throw new Error("commitAgentMessageV2 reverted on chain (tx 0xdead)");
      }
      sendCommitCalls.push(messageHash);
      return ("0xc" + "0".repeat(63)) as Hex;
    },
    async getSponsorBalanceWei(): Promise<bigint> {
      return opts.sponsorWei ?? 10n * 10n ** 18n;
    },
    buildAgentWalletClient(_agent: HDAccount): WalletClient {
      return {} as WalletClient;
    },
  };
  return obj as DayChainOps & {
    sendCommitCalls: Hex[];
    getMessageHashCalls: number;
    roomCalls: number;
  };
}

// ─── Fake WS broadcaster ───────────────────────────────────────────────────
function makeBroadcaster() {
  const calls: any[] = [];
  return {
    calls,
    broadcastToRoom(roomId: any, chainId: any, event: any) {
      calls.push({ roomId, chainId, event });
    },
  } satisfies DayBroadcaster & { calls: any[] };
}

// ─── Fake inferChatFn ──────────────────────────────────────────────────────
function makeInferFn(opts: {
  response?: string;
  timeout?: boolean;
  throws?: boolean;
  delayMs?: number;
}): InferChatFn {
  return (async (_req, _opts) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throws) throw new Error("infer threw");
    if (opts.timeout) {
      return {
        result: null,
        status: 0,
        requestId: 42n,
        txHash: ("0xab" + "ab".repeat(31)) as Hex,
        latencySec: 0.01,
      };
    }
    return {
      result: { response: opts.response ?? "All quiet today, watching B closely.", status: 2 },
      status: 2,
      requestId: 42n,
      txHash: ("0xab" + "ab".repeat(31)) as Hex,
      latencySec: 0.01,
    };
  }) as InferChatFn;
}

// ─── Test-wide helpers ─────────────────────────────────────────────────────
function makeEvent(overrides?: Partial<DayStartedEvent>): DayStartedEvent {
  return {
    type: "DAY_STARTED",
    chainId: 50312,
    roomId: "8",
    phaseId: "D1-DAY",
    dayNumber: 1,
    blockNumber: 0,
    txHash: ZERO_BYTES32,
    logIndex: 0,
    ...overrides,
  };
}

const ROOM_ID = 8n;

describe("DayHandler — happy path", () => {
  it("4 agents each commit one message in round-robin order", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const a1 = deriveAgent(ROOM_ID, 1).address;
    const a2 = deriveAgent(ROOM_ID, 2).address;
    const a3 = deriveAgent(ROOM_ID, 3).address;
    const agents = [a0, a1, a2, a3];

    const chain = makeChain({ alive: agents, agentAddrs: agents });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "I think B is suspicious." }),
    });

    const outcomes = await h.handle(makeEvent());

    expect(outcomes).toHaveLength(4);
    expect(outcomes.every((o) => o.status === "COMMITTED")).toBe(true);
    expect(outcomes.every((o) => o.msgKind === "MSG")).toBe(true);
    expect(chain.sendCommitCalls.length).toBe(4);
    expect(ws.calls.length).toBe(4);
    expect(ws.calls[0].event).toMatchObject({ type: "agent-chat", text: "I think B is suspicious." });
  });
});

describe("DayHandler — phase gate pinned to contract GamePhase (regression)", () => {
  // GamePhase enum (src/types/contract.ts): REVEAL=2, DAY=3. The handler's
  // PHASE_DAY constant was 2 (REVEAL) so it skipped every real DAY — agents
  // were mute in DAY. These pin the gate to the literal contract values so it
  // can't silently regress regardless of the local PHASE_DAY symbol.
  const LITERAL_DAY = 3;
  const LITERAL_REVEAL = 2;

  it("ACTS when room phase is DAY (3): agent commits", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0], phaseSequence: [LITERAL_DAY] });
    const h = new DayHandler({
      redis: new FakeRedis() as any,
      chainOpsFor: () => chain,
      ws: makeBroadcaster(),
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "hello all" }),
    });
    const outcomes = await h.handle(makeEvent());
    expect(outcomes).toHaveLength(1);
    expect(chain.sendCommitCalls.length).toBe(1); // not skipped for phase
  });

  it("SKIPS when room phase is REVEAL (2): no commit", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0], phaseSequence: [LITERAL_REVEAL] });
    const h = new DayHandler({
      redis: new FakeRedis() as any,
      chainOpsFor: () => chain,
      ws: makeBroadcaster(),
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "hello all" }),
    });
    const outcomes = await h.handle(makeEvent());
    expect(chain.sendCommitCalls.length).toBe(0); // skipped — wrong phase
  });
});

describe("DayHandler — SCRUBBED_SKIP path", () => {
  it("scrubber blocks role-leak: commit goes through with SKIP_SCRUBBED, no WS", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "I am the detective and I checked B last night" }),
    });

    const outcomes = await h.handle(makeEvent());

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("COMMITTED");
    expect(outcomes[0].msgKind).toBe("SKIP_SCRUBBED");
    expect(chain.sendCommitCalls.length).toBe(1);
    expect(ws.calls.length).toBe(0);
  });
});

describe("DayHandler — INFER_TIMEOUT path", () => {
  it("timeout returns INFER_TIMEOUT, action key STAYS HELD, no commit", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ timeout: true }),
    });

    const ev = makeEvent();
    const outcomes = await h.handle(ev);

    expect(outcomes[0].status).toBe("INFER_TIMEOUT");
    expect(chain.sendCommitCalls.length).toBe(0);
    expect(ws.calls.length).toBe(0);
    const actionKey = agentActionProcessedKey(
      50312,
      ev.roomId,
      ev.phaseId,
      a0,
      "day-chat"
    );
    expect(await redis.get(actionKey)).not.toBeNull();
  });

  it("inferChatFn throws → INFER_TIMEOUT, action key STAYS HELD", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ throws: true }),
    });

    const ev = makeEvent();
    const outcomes = await h.handle(ev);
    expect(outcomes[0].status).toBe("INFER_TIMEOUT");
    expect(chain.sendCommitCalls.length).toBe(0);
    const actionKey = agentActionProcessedKey(50312, ev.roomId, ev.phaseId, a0, "day-chat");
    expect(await redis.get(actionKey)).not.toBeNull();
  });
});

describe("DayHandler — F3 phase advanced during infer", () => {
  it("PHASE_ADVANCED after recheck → no commit, no WS, action key released", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    // getRoom calls: 1 (initial), 2 (per-agent pre-check), 3 (F3 recheck after infer) → NIGHT
    const chain = makeChain({
      alive: [a0],
      agentAddrs: [a0],
      phaseSequence: [PHASE_DAY, PHASE_DAY, PHASE_NIGHT],
    });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "Bob is sus" }),
    });

    const ev = makeEvent();
    const outcomes = await h.handle(ev);
    expect(outcomes[0].status).toBe("PHASE_ADVANCED");
    expect(chain.sendCommitCalls.length).toBe(0);
    expect(ws.calls.length).toBe(0);
    const actionKey = agentActionProcessedKey(50312, ev.roomId, ev.phaseId, a0, "day-chat");
    expect(await redis.get(actionKey)).toBeNull();
  });
});

describe("DayHandler — sponsor low", () => {
  it("SPONSOR_LOW skips agent and persists reason", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0], sponsorWei: 0n });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const inferSpy = vi.fn();
    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: (async (...args: any[]) => {
        inferSpy(...args);
        return makeInferFn({ response: "x" })(args[0], args[1]);
      }) as InferChatFn,
    });

    const ev = makeEvent();
    const outcomes = await h.handle(ev);
    expect(outcomes[0].status).toBe("SPONSOR_LOW");
    expect(inferSpy).not.toHaveBeenCalled();
    expect(chain.sendCommitCalls.length).toBe(0);
    const reason = await redis.get(
      agentSkipReasonKey(50312, ev.roomId, ev.phaseId, a0)
    );
    expect(reason).toBe("sponsor-low-no-inference");
  });
});

describe("DayHandler — F1 dedup pre-check", () => {
  it("skipped-already-committed when getAgentMessageHash returns non-zero", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const fakeHash = ("0x" + "12".repeat(32)) as Hex;
    const chain = makeChain({
      alive: [a0],
      agentAddrs: [a0],
      preCommittedHash: fakeHash,
    });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const inferSpy = vi.fn();
    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: (async (...args: any[]) => {
        inferSpy();
        return makeInferFn({})(args[0], args[1]);
      }) as InferChatFn,
    });

    const ev = makeEvent();
    const outcomes = await h.handle(ev);
    expect(outcomes[0].status).toBe("skipped-already-committed");
    expect(inferSpy).not.toHaveBeenCalled();
    expect(chain.sendCommitCalls.length).toBe(0);
    const actionKey = agentActionProcessedKey(50312, ev.roomId, ev.phaseId, a0, "day-chat");
    expect(await redis.get(actionKey)).toBeNull();
  });
});

describe("DayHandler — replay idempotency", () => {
  it("second handle() with same event returns all skipped-action-idempotent", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "Hello" }),
    });

    await h.handle(makeEvent());
    // Reset chain dedup so the second pass would NOT hit "skipped-already-committed"
    // — we want the action-key path to fire.
    const chain2 = makeChain({ alive: [a0], agentAddrs: [a0] });
    const h2 = new DayHandler({
      redis,
      chainOpsFor: () => chain2,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "Hello" }),
    });
    const outcomes = await h2.handle(makeEvent());
    expect(outcomes[0].status).toBe("skipped-action-idempotent");
    expect(chain2.sendCommitCalls.length).toBe(0);
  });
});

describe("DayHandler — F-new-round4-1 commit failure recovery", () => {
  it("commit revert + stored == our hash → success-equivalent COMMITTED", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    // We don't know messageHash ahead of time, so we hook chain to return whatever the handler last computed.
    // Strategy: capture sendCommit's argument via a thrown sentinel, then return that arg on next getAgentMessageHash.
    let capturedHash: Hex | null = null;
    const chain: DayChainOps & any = makeChain({ alive: [a0], agentAddrs: [a0] });
    chain.sendCommitMessageV2 = async (
      _agent: any,
      _r: any,
      _p: any,
      h: Hex
    ): Promise<Hex> => {
      capturedHash = h;
      throw new Error("commitAgentMessageV2 reverted on chain (tx 0xdead)");
    };
    chain.getAgentMessageHash = async (): Promise<Hex> => {
      return capturedHash ?? ZERO_BYTES32;
    };
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "All good" }),
    });
    const outcomes = await h.handle(makeEvent());
    expect(outcomes[0].status).toBe("COMMITTED");
    expect(ws.calls.length).toBe(1);
  });

  it("commit revert + stored != our hash → COMMIT_CONFLICT, no WS", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const otherHash = ("0x" + "ff".repeat(32)) as Hex;
    const chain: DayChainOps & any = makeChain({ alive: [a0], agentAddrs: [a0] });
    let calls = 0;
    chain.getAgentMessageHash = async (): Promise<Hex> => {
      calls += 1;
      // First call: pre-check returns 0 (no commit yet).
      // Later calls (after revert): return otherHash (conflict).
      return calls === 1 ? ZERO_BYTES32 : otherHash;
    };
    chain.sendCommitMessageV2 = async (): Promise<Hex> => {
      throw new Error("commitAgentMessageV2 reverted on chain (tx 0xdead)");
    };
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;
    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "All good" }),
    });
    const outcomes = await h.handle(makeEvent());
    expect(outcomes[0].status).toBe("COMMIT_CONFLICT");
    expect(ws.calls.length).toBe(0);
  });

  it("commit revert + stored == 0 → COMMIT_FAILED, no WS", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain: DayChainOps & any = makeChain({ alive: [a0], agentAddrs: [a0] });
    chain.getAgentMessageHash = async (): Promise<Hex> => ZERO_BYTES32;
    chain.sendCommitMessageV2 = async (): Promise<Hex> => {
      throw new Error("commitAgentMessageV2 reverted on chain (tx 0xdead)");
    };
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;
    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "All good" }),
    });
    const outcomes = await h.handle(makeEvent());
    expect(outcomes[0].status).toBe("COMMIT_FAILED");
    expect(ws.calls.length).toBe(0);
  });
});

describe("DayHandler — rotation by dayNumber", () => {
  it("dayNumber=0 starts at sorted[0]; dayNumber=1 starts at sorted[1]", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const a1 = deriveAgent(ROOM_ID, 1).address;
    const sorted = [a0, a1].sort((x, y) =>
      x.toLowerCase() < y.toLowerCase() ? -1 : 1
    );

    const chain = makeChain({ alive: [a0, a1], agentAddrs: [a0, a1] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "x" }),
    });

    await h.handle(makeEvent({ dayNumber: 0 }));
    const orderDay0 = ws.calls.map((c) => c.event.by);
    expect(orderDay0[0].toLowerCase()).toBe(sorted[0].toLowerCase());

    // Reset.
    const redis2 = new FakeRedis() as any;
    const ws2 = makeBroadcaster();
    const chain2 = makeChain({ alive: [a0, a1], agentAddrs: [a0, a1] });
    const h2 = new DayHandler({
      redis: redis2,
      chainOpsFor: () => chain2,
      ws: ws2,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "x" }),
    });
    await h2.handle(makeEvent({ dayNumber: 1 }));
    const orderDay1 = ws2.calls.map((c) => c.event.by);
    expect(orderDay1[0].toLowerCase()).toBe(sorted[1].toLowerCase());
  });
});

describe("DayHandler — role miss generic prompt", () => {
  it("role NONE → prompt instructs 'do not know your role'", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    let capturedPrompt: { roles: string[]; messages: string[] } | null = null;
    const inferFn: InferChatFn = (async (req, _opts) => {
      capturedPrompt = { roles: req.roles, messages: req.messages };
      return {
        result: { response: "Quiet day so far.", status: 2 },
        status: 2,
        requestId: 42n,
        txHash: ("0xab" + "ab".repeat(31)) as Hex,
        latencySec: 0.01,
      };
    }) as InferChatFn;

    // No setAgentRole — role defaults to NONE.
    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: inferFn,
    });
    const outcomes = await h.handle(makeEvent());
    expect(outcomes[0].status).toBe("COMMITTED");
    expect(capturedPrompt).not.toBeNull();
    const system = capturedPrompt!.messages[0];
    expect(system.toLowerCase()).toContain("do not know your role");
    // No role-revealing claim — "Your hidden role is X" must not appear.
    expect(system).not.toMatch(/your hidden role is /i);
    expect(system).not.toMatch(/you are (the )?(detective|doctor|citizen)/i);
    expect(system).not.toMatch(/you are the mafia/i);
  });
});

describe("DayHandler — WS payload omits somniaRequestId", () => {
  it("WS payload contains only {by,text,persona,day,messageHash,commitTxHash}", async () => {
    const a0 = deriveAgent(ROOM_ID, 0).address;
    const chain = makeChain({ alive: [a0], agentAddrs: [a0] });
    const ws = makeBroadcaster();
    const redis = new FakeRedis() as any;

    const h = new DayHandler({
      redis,
      chainOpsFor: () => chain,
      ws,
      mnemonic: TEST_MNEMONIC,
      inferChatFn: makeInferFn({ response: "Hello." }),
    });

    await h.handle(makeEvent());
    expect(ws.calls).toHaveLength(1);
    const payload = ws.calls[0].event;
    expect(Object.keys(payload).sort()).toEqual(
      ["by", "commitTxHash", "day", "messageHash", "persona", "text", "type"].sort()
    );
    expect("somniaRequestId" in payload).toBe(false);
    expect("promptHash" in payload).toBe(false);
    expect("rawResponseHash" in payload).toBe(false);
  });
});

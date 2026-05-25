/**
 * Unit tests for VotingHandler. Pure in-process — no chain, no LLM, no Redis
 * server. Every external surface is faked.
 *
 * Coverage:
 *   - happy path (1 agent): infer → vote → commit → trace persisted in Redis
 *   - LLM timeout falls back deterministically; vote+commit still fire
 *   - action idempotency: second handle() short-circuits before LLM call
 *   - on-chain commitment present → skipped-already-committed (defence-in-depth)
 *   - HAS_VOTED flag set → skipped-already-voted, no LLM cost
 *   - PHASE != VOTING → empty outcome
 *   - no on-chain agents → empty outcome
 *   - mnemonic mismatch (no derivation matches) → empty outcome
 *   - vote tx throws → vote-failed; commit not attempted; no trace persisted
 *   - commit tx throws → commit-failed but trace IS persisted (so retry can re-issue)
 *   - parallelism: 2 agents each get a vote+commit; outcomes return in both
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { keccak256, toHex, type Address, type Hex } from "viem";

import {
  VotingHandler,
  type VoteChainOps,
  type VotingStartedEvent,
  type RoomSnapshot,
  type PlayerSnapshot,
  computeVoteActionHash,
} from "../../src/agents/voting.js";
import {
  agentActionProcessedKey,
  agentTraceKey,
} from "../../src/agents/redis-keys.js";
import {
  computeTraceCommitment,
  makePhaseId,
} from "../../src/agents/trace.js";
import { deriveAgentWallets } from "../../src/agents/wallets.js";
import type { InferStringResult } from "../../src/agents/llm-call.js";

// ─── In-memory Redis fake (mirrors the dispatcher test fixture) ────────────
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

// ─── Constants ─────────────────────────────────────────────────────────────
const CHAIN_ID = 50312;
const DIAMOND: Hex = "0x031b6746155ce11c7b533935f4674f5fc4682338";
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const ROOM_ID = 7n;
const DAY_COUNT = 3;
const PHASE_VOTING = 4;
const ZERO32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const VOTE_TX_HASH_PREFIX = "0xaaaa";
const COMMIT_TX_HASH_PREFIX = "0xbbbb";
const LLM_TX_HASH: Hex =
  "0xcccc000000000000000000000000000000000000000000000000000000000001";

function votingEvent(over: Partial<VotingStartedEvent> = {}): VotingStartedEvent {
  return {
    type: "VOTING_STARTED",
    chainId: CHAIN_ID,
    roomId: ROOM_ID.toString(),
    phaseId: `D${DAY_COUNT}-VOTING`,
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
  agentSet: Set<string>; // lowercase addresses returned by isAgent==true
  existingCommitment: Hex; // returned by getAgentTraceCommitment
}

function makeFakeChain(
  state: FakeChainState,
  spies: {
    sendVote?: ReturnType<typeof vi.fn>;
    sendCommit?: ReturnType<typeof vi.fn>;
  } = {}
): VoteChainOps {
  const sendVote =
    spies.sendVote ??
    vi.fn(async (_account, _roomId, target: Address) => {
      return ((VOTE_TX_HASH_PREFIX +
        target.slice(2, 6).toLowerCase() +
        "0".repeat(58)) as Hex);
    });
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
    sendVote,
    sendCommitInference: sendCommit,
    buildAgentWalletClient: vi.fn(() => ({} as any)),
  };
}

function deriveAgentAddresses(count: number, roomId: bigint = ROOM_ID): Address[] {
  return deriveAgentWallets(TEST_MNEMONIC, roomId, count).map((w) => w.address);
}

function activePlayer(addr: Address, flags: number = 0x2): PlayerSnapshot {
  return { wallet: addr, flags };
}

// ─── Tests ─────────────────────────────────────────────────────────────────
describe("VotingHandler", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  function buildHandler(opts: {
    chain: VoteChainOps;
    inferFn?: (
      req: any,
      opts: any
    ) => Promise<InferStringResult>;
    chatHistoryFor?: any;
  }) {
    return new VotingHandler({
      redis: redis as any,
      chainOpsFor: () => opts.chain,
      mnemonic: TEST_MNEMONIC,
      inferFn: opts.inferFn as any,
      chatHistoryFor: opts.chatHistoryFor,
    });
  }

  it("happy path: 1 agent — infer → vote → commit → trace stored", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const llmTarget = otherAddr;
    const llmText = `vote ${llmTarget}`;

    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });

    const inferFn = vi.fn(async () => ({
      text: llmText,
      status: 2,
      requestId: 42n,
      txHash: LLM_TX_HASH,
      latencySec: 1.2,
    }));

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("voted");
    expect(outcomes[0].agent).toBe(agentAddr);
    expect(outcomes[0].target).toBe(llmTarget);
    expect(outcomes[0].decisionSource).toBe("llm");
    expect(outcomes[0].voteTxHash?.startsWith(VOTE_TX_HASH_PREFIX)).toBe(true);
    expect(outcomes[0].commitTxHash?.startsWith(COMMIT_TX_HASH_PREFIX)).toBe(true);
    expect(outcomes[0].llmTxHash).toBe(LLM_TX_HASH);

    expect(inferFn).toHaveBeenCalledTimes(1);
    expect(chain.sendVote).toHaveBeenCalledTimes(1);
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(1);

    const vArgs = (chain.sendVote as any).mock.calls[0];
    expect(vArgs[1]).toBe(ROOM_ID); // roomId
    expect(vArgs[2]).toBe(llmTarget); // target

    const cArgs = (chain.sendCommitInference as any).mock.calls[0];
    expect(cArgs[1]).toBe(ROOM_ID);
    expect(cArgs[2]).toBe(makePhaseId("VOTING", DAY_COUNT));
    expect(cArgs[3]).toBe(computeVoteActionHash(llmTarget));

    // Trace persisted privately
    const traceRaw = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-VOTING`, agentAddr)
    );
    expect(traceRaw).not.toBeNull();
    const trace = JSON.parse(traceRaw!);
    expect(trace.target).toBe(llmTarget);
    expect(trace.somniaRequestId).toBe("42");
    expect(trace.actionHash).toBe(computeVoteActionHash(llmTarget));
    expect(trace.voteTxHash).toMatch(/^0xaaaa/);
    expect(trace.commitTxHash).toMatch(/^0xbbbb/);
    expect(trace.prompt).toContain("Day 3");
    expect(trace.prompt).toContain(otherAddr);
  });

  it("headless (no alive human): staggers agent votes so they don't all land at once", async () => {
    const [a1, a2] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(a1), activePlayer(a2)],
      agentSet: new Set([a1.toLowerCase(), a2.toLowerCase()]), // both agents → headless
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => ({
      text: `vote ${a1}`,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));
    const sleep = vi.fn(async () => {});
    const handler = new VotingHandler({
      redis: redis as any,
      chainOpsFor: () => chain,
      mnemonic: TEST_MNEMONIC,
      inferFn: inferFn as any,
      voteStaggerMs: 4000,
      sleep,
    } as any);

    await handler.handle(votingEvent());

    // 2 agents: index 0 votes immediately, index 1 waits one stagger.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(4000);
    expect(chain.sendVote).toHaveBeenCalledTimes(2);
  });

  it("mixed (an alive human present): does NOT stagger — parallel for the voting window", async () => {
    const [a1, a2] = deriveAgentAddresses(2);
    const human = "0x00000000000000000000000000000000000000aa" as Address;
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 3 },
      players: [activePlayer(a1), activePlayer(a2), activePlayer(human)],
      agentSet: new Set([a1.toLowerCase(), a2.toLowerCase()]), // human is NOT an agent
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => ({
      text: `vote ${human}`,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));
    const sleep = vi.fn(async () => {});
    const handler = new VotingHandler({
      redis: redis as any,
      chainOpsFor: () => chain,
      mnemonic: TEST_MNEMONIC,
      inferFn: inferFn as any,
      voteStaggerMs: 4000,
      sleep,
    } as any);

    await handler.handle(votingEvent());

    expect(sleep).not.toHaveBeenCalled();
    expect(chain.sendVote).toHaveBeenCalledTimes(2);
  });

  it("traceCommitment in tx matches the off-chain computation", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const llmTarget = otherAddr;
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => ({
      text: llmTarget,
      status: 2,
      requestId: 99n,
      txHash: LLM_TX_HASH,
      latencySec: 0.5,
    }));

    const handler = buildHandler({ chain, inferFn });
    await handler.handle(votingEvent());

    // Reconstruct what should have been committed
    const traceRaw = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-VOTING`, agentAddr)
    );
    const trace = JSON.parse(traceRaw!);
    const expected = computeTraceCommitment({
      diamond: DIAMOND,
      chainId: BigInt(CHAIN_ID),
      roomId: ROOM_ID,
      phaseId: makePhaseId("VOTING", DAY_COUNT),
      agent: agentAddr,
      salt: trace.salt,
      somniaRequestId: 99n,
      promptHash: trace.promptHash,
      responseHash: trace.responseHash,
      actionHash: trace.actionHash,
    });

    const cArgs = (chain.sendCommitInference as any).mock.calls[0];
    expect(cArgs[4]).toBe(expected); // traceCommitment passed to chain
    expect(trace.traceCommitment).toBe(expected); // mirrored in trace store
  });

  it("LLM timeout → deterministic fallback, vote+commit still fire", async () => {
    const [agentAddr, a, b] = deriveAgentAddresses(3);
    // Fallback picks the lowest non-self alive address.
    const others = [a, b]
      .filter((x) => x.toLowerCase() !== agentAddr.toLowerCase())
      .sort();
    const expectedFallback = others[0];

    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 3 },
      players: [activePlayer(agentAddr), activePlayer(a), activePlayer(b)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    // Simulate timeout: text=null, status=0.
    const inferFn = vi.fn(async () => ({
      text: null,
      status: 0,
      requestId: 7n,
      txHash: LLM_TX_HASH,
      latencySec: 25,
    }));

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes[0].status).toBe("voted");
    expect(outcomes[0].decisionSource).toBe("fallback");
    expect(outcomes[0].target).toBe(expectedFallback);
    expect(chain.sendVote).toHaveBeenCalledTimes(1);
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(1);
  });

  it("action idempotency: second handle() short-circuits before LLM", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => ({
      text: otherAddr,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));

    const handler = buildHandler({ chain, inferFn });
    await handler.handle(votingEvent());
    const second = await handler.handle(votingEvent());

    expect(second[0].status).toBe("skipped-action-idempotent");
    expect(inferFn).toHaveBeenCalledTimes(1); // not called twice
    expect(chain.sendVote).toHaveBeenCalledTimes(1);
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(1);

    // Action key is held
    const held = await redis.get(
      agentActionProcessedKey(
        CHAIN_ID,
        ROOM_ID.toString(),
        `D${DAY_COUNT}-VOTING`,
        agentAddr,
        "vote"
      )
    );
    expect(held).not.toBeNull();
  });

  it("on-chain commitment present → skipped-already-committed (no work done)", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment:
        "0xdead000000000000000000000000000000000000000000000000000000000000",
    });
    const inferFn = vi.fn(async () => {
      throw new Error("LLM must not be called");
    });

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes[0].status).toBe("skipped-already-committed");
    expect(inferFn).not.toHaveBeenCalled();
    expect(chain.sendVote).not.toHaveBeenCalled();
    expect(chain.sendCommitInference).not.toHaveBeenCalled();
  });

  it("HAS_VOTED flag set → skipped-already-voted (no LLM cost)", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [
        activePlayer(agentAddr, 0x2 | 0x4), // ACTIVE | HAS_VOTED
        activePlayer(otherAddr),
      ],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => {
      throw new Error("LLM must not be called");
    });

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes[0].status).toBe("skipped-already-voted");
    expect(inferFn).not.toHaveBeenCalled();
    expect(chain.sendVote).not.toHaveBeenCalled();
  });

  it("room not in VOTING phase → empty outcome (event arrived too late)", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: 5 /* NIGHT */, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn();
    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());
    expect(outcomes).toEqual([]);
    expect(inferFn).not.toHaveBeenCalled();
  });

  it("no on-chain agents in room → empty outcome", async () => {
    const [a, b] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(a), activePlayer(b)],
      agentSet: new Set(), // no agents
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn();
    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());
    expect(outcomes).toEqual([]);
    expect(inferFn).not.toHaveBeenCalled();
  });

  it("agent in room but not derivable from our mnemonic → empty outcome", async () => {
    const stranger: Address = "0x1234567890123456789012345678901234567890";
    const [_a, b] = deriveAgentAddresses(2); // these are OUR derivable addrs
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(stranger), activePlayer(b)],
      agentSet: new Set([stranger.toLowerCase()]), // only stranger is an agent
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn();
    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());
    expect(outcomes).toEqual([]);
    expect(inferFn).not.toHaveBeenCalled();
  });

  it("vote tx throws → vote-failed, no commit attempted, no trace persisted", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const sendVote = vi.fn(async () => {
      throw new Error("nonce too low");
    });
    const sendCommit = vi.fn();
    const chain = makeFakeChain(
      {
        room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
        players: [activePlayer(agentAddr), activePlayer(otherAddr)],
        agentSet: new Set([agentAddr.toLowerCase()]),
        existingCommitment: ZERO32,
      },
      { sendVote, sendCommit }
    );
    const inferFn = vi.fn(async () => ({
      text: otherAddr,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes[0].status).toBe("vote-failed");
    expect(outcomes[0].err).toContain("nonce too low");
    expect(sendCommit).not.toHaveBeenCalled();

    const trace = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-VOTING`, agentAddr)
    );
    expect(trace).toBeNull();
  });

  it("commit tx throws → commit-failed but trace IS persisted (for retry)", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const sendVote = vi.fn(async () => "0xaaaa" + "0".repeat(60) as Hex);
    const sendCommit = vi.fn(async () => {
      throw new Error("execution reverted: NotAgent");
    });
    const chain = makeFakeChain(
      {
        room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
        players: [activePlayer(agentAddr), activePlayer(otherAddr)],
        agentSet: new Set([agentAddr.toLowerCase()]),
        existingCommitment: ZERO32,
      },
      { sendVote, sendCommit }
    );
    const inferFn = vi.fn(async () => ({
      text: otherAddr,
      status: 2,
      requestId: 5n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes[0].status).toBe("commit-failed");
    expect(outcomes[0].voteTxHash).toBeDefined();
    expect(outcomes[0].commitTxHash).toBeUndefined();

    const traceRaw = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-VOTING`, agentAddr)
    );
    expect(traceRaw).not.toBeNull();
    const trace = JSON.parse(traceRaw!);
    expect(trace.voteTxHash).toBeDefined();
    expect(trace.commitTxHash).toBeNull();
  });

  it("2 agents in same room → both vote+commit in parallel", async () => {
    const addrs = deriveAgentAddresses(3);
    const [agent1, agent2, plain] = addrs;
    const llmTarget = plain; // both agents vote the same plain player

    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 3 },
      players: [
        activePlayer(agent1),
        activePlayer(agent2),
        activePlayer(plain),
      ],
      agentSet: new Set([agent1.toLowerCase(), agent2.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => ({
      text: llmTarget,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "voted")).toBe(true);
    expect(inferFn).toHaveBeenCalledTimes(2);
    expect(chain.sendVote).toHaveBeenCalledTimes(2);
    expect(chain.sendCommitInference).toHaveBeenCalledTimes(2);

    // Each agent's trace independently keyed in Redis
    const t1 = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-VOTING`, agent1)
    );
    const t2 = await redis.get(
      agentTraceKey(CHAIN_ID, ROOM_ID.toString(), `D${DAY_COUNT}-VOTING`, agent2)
    );
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(JSON.parse(t1!).salt).not.toBe(JSON.parse(t2!).salt);
  });

  it("chatHistoryFor() injects prior chat into the prompt", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async (req: any) => ({
      text: otherAddr,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
      _capturedPrompt: req.prompt, // smuggle out for assertion
    } as any));

    const chatHistoryFor = vi.fn(async () => [
      { from: otherAddr, text: "I think 0x123 is suspicious" },
    ]);

    const handler = buildHandler({ chain, inferFn, chatHistoryFor });
    await handler.handle(votingEvent());

    expect(chatHistoryFor).toHaveBeenCalledWith(
      CHAIN_ID,
      ROOM_ID.toString(),
      DAY_COUNT
    );
    const promptArg = (inferFn as any).mock.calls[0][0].prompt as string;
    expect(promptArg).toContain("suspicious");
  });

  // ── Review-finding regression tests ───────────────────────────────────

  it("only-self-alive → skipped-no-targets (no LLM call, no vote tx)", async () => {
    const [agentAddr] = deriveAgentAddresses(1);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 1 },
      players: [activePlayer(agentAddr)], // only self
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => {
      throw new Error("LLM must not be called");
    });

    const handler = buildHandler({ chain, inferFn });
    const outcomes = await handler.handle(votingEvent());

    expect(outcomes[0].status).toBe("skipped-no-targets");
    expect(inferFn).not.toHaveBeenCalled();
    expect(chain.sendVote).not.toHaveBeenCalled();
  });

  it("inferString throws → action key released → retry runs LLM again", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    let callCount = 0;
    const inferFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("transient RPC error");
      return {
        text: otherAddr,
        status: 2,
        requestId: 9n,
        txHash: LLM_TX_HASH,
        latencySec: 1,
      };
    });

    const handler = buildHandler({ chain, inferFn });
    const first = await handler.handle(votingEvent());
    expect(first[0].status).toBe("vote-failed");
    expect(first[0].err).toContain("transient");

    // Retry — pre-fix the action key stayed claimed and we'd hit
    // skipped-action-idempotent. Post-fix the key was released since the
    // failure happened BEFORE the vote tx.
    const second = await handler.handle(votingEvent());
    expect(second[0].status).toBe("voted");
    expect(inferFn).toHaveBeenCalledTimes(2);
  });

  it("inferString fails AFTER vote tx → action key stays held (no double-vote)", async () => {
    // Sanity-check: when failure happens after the on-chain vote, we keep the
    // action key so a retry can't issue a SECOND vote tx.
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const sendCommit = vi.fn(async () => {
      throw new Error("commit revert");
    });
    const chain = makeFakeChain(
      {
        room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
        players: [activePlayer(agentAddr), activePlayer(otherAddr)],
        agentSet: new Set([agentAddr.toLowerCase()]),
        existingCommitment: ZERO32,
      },
      { sendCommit }
    );
    const inferFn = vi.fn(async () => ({
      text: otherAddr,
      status: 2,
      requestId: 1n,
      txHash: LLM_TX_HASH,
      latencySec: 1,
    }));

    const handler = buildHandler({ chain, inferFn });
    const first = await handler.handle(votingEvent());
    expect(first[0].status).toBe("commit-failed");
    expect(chain.sendVote).toHaveBeenCalledTimes(1);

    // Retry must be short-circuited by the action key (vote tx already fired)
    const second = await handler.handle(votingEvent());
    expect(second[0].status).toBe("skipped-action-idempotent");
    expect(chain.sendVote).toHaveBeenCalledTimes(1); // NOT incremented
  });
});

describe("computeVoteActionHash", () => {
  it("matches keccak(abi.encode('VOTE', address))", () => {
    const target: Address = "0x3d92975573e29854e2130d1e70fed76f76388dc1";
    const a = computeVoteActionHash(target);
    // Re-encode manually to assert format
    const expected = keccak256(
      // string + address abi-encoded
      "0x" +
        // string offset 0x40
        "0000000000000000000000000000000000000000000000000000000000000040" +
        // address (left padded)
        "0000000000000000000000003d92975573e29854e2130d1e70fed76f76388dc1" +
        // string length 4
        "0000000000000000000000000000000000000000000000000000000000000004" +
        // "VOTE" + zero padding
        "564f54450000000000000000000000000000000000000000000000000000000000".slice(0, 64)
    );
    expect(a).toBe(expected);
  });

  it("changes per-target", () => {
    const a: Address = "0x3d92975573e29854e2130d1e70fed76f76388dc1";
    const b: Address = "0x0000000000000000000000000000000000000001";
    expect(computeVoteActionHash(a)).not.toBe(computeVoteActionHash(b));
  });
});

describe("VotingHandler — agent auto-topup gate", () => {
  it("funds before inference when ensureFunded provided, then votes", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const order: string[] = [];
    const inferFn = vi.fn(async () => {
      order.push("infer");
      return { text: `vote ${otherAddr}`, status: 2, requestId: 1n, txHash: LLM_TX_HASH, latencySec: 1 };
    });
    const handler = new VotingHandler({
      redis: new FakeRedis() as any,
      chainOpsFor: () => chain,
      mnemonic: TEST_MNEMONIC,
      inferFn: inferFn as any,
      ensureFunded: async () => {
        order.push("fund");
        return true;
      },
    });
    const outcomes = await handler.handle(votingEvent());
    expect(order).toEqual(["fund", "infer"]); // funded BEFORE inference deposit
    expect(outcomes[0].status).toBe("voted");
  });

  it("skips inference + vote with skipped-unfunded when ensureFunded returns false", async () => {
    const [agentAddr, otherAddr] = deriveAgentAddresses(2);
    const chain = makeFakeChain({
      room: { phase: PHASE_VOTING, dayCount: DAY_COUNT, aliveCount: 2 },
      players: [activePlayer(agentAddr), activePlayer(otherAddr)],
      agentSet: new Set([agentAddr.toLowerCase()]),
      existingCommitment: ZERO32,
    });
    const inferFn = vi.fn(async () => ({
      text: "x", status: 2, requestId: 1n, txHash: LLM_TX_HASH, latencySec: 1,
    }));
    const handler = new VotingHandler({
      redis: new FakeRedis() as any,
      chainOpsFor: () => chain,
      mnemonic: TEST_MNEMONIC,
      inferFn: inferFn as any,
      ensureFunded: async () => false,
    });
    const outcomes = await handler.handle(votingEvent());
    expect(outcomes[0].status).toBe("skipped-unfunded");
    expect(inferFn).not.toHaveBeenCalled();
    expect(chain.sendVote).not.toHaveBeenCalled();
  });
});

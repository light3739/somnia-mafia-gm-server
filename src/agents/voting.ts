/**
 * agents/voting.ts — VOTING phase handler (Task 4b).
 *
 * When the listener emits a VOTING_STARTED AgentEvent, this handler:
 *   1. Enumerates the agents currently in that room via AgentRegistryFacet.isAgent.
 *   2. For each agent, in parallel (voting window is ~30s — sequential won't fit):
 *      a. Claims an action-level idempotency slot in Redis. Skip if already held.
 *      b. Skips if the agent already has `HAS_VOTED` set on chain or is not active.
 *      c. Runs Somnia `inferString` with allowedValues = alive non-self addresses.
 *      d. Resolves the LLM response to a target (with deterministic fallback).
 *      e. Sends `vote(roomId, target)` from the agent EOA.
 *      f. Computes `traceCommitment` per the v3 EIP-712-style domain.
 *      g. Sends `commitAgentInference` from the agent EOA (action-level audit on chain).
 *      h. Persists full trace material (salt, prompt, response, hashes, tx
 *         hashes) into Redis under `agentTraceKey` for post-game reveal.
 *
 * Decision discipline:
 *   - Two transactions per agent (Pattern B). Pattern A — single tx via
 *     AgentBrainFacet + session-key proxy — is stretch goal post-MVP.
 *   - actionHash convention is documented in `registry-abi.voteActionHash`.
 *   - Trace material is kept *private* in Redis until GameEnded; revealing
 *     mid-game would expose the system prompt, which leaks the agent's role.
 *     See memory [[agent-role-secrecy]].
 *
 * Test surface: every chain/LLM dependency is injected through interfaces so
 * the handler can be unit-tested without WS connections or actual deposits.
 */
import type { Redis } from "ioredis";
import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type HDAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { logger } from "../utils/logger.js";
import {
  agentActionProcessedKey,
  agentTraceKey,
  IDEMPOTENCY_TTL_SECONDS,
} from "./redis-keys.js";
import {
  computeTraceCommitment,
  makePhaseId,
  randomSalt,
} from "./trace.js";
import { resolveDecision, buildVotePrompt } from "./decision-schema.js";
import {
  inferStringOnSomnia as defaultInferFn,
  type InferStringResult,
} from "./llm-call.js";
import { matchWalletsToAgents, type AgentWallet } from "./wallets.js";
import { voteActionHash } from "./registry-abi.js";
import { loadMemoryPromptLines } from "./memory.js";
import {
  loadPublicGameContext,
  loadRecentPromptChat,
} from "./strategic-context.js";

// FLAGS bits mirror src/types/contract.ts. Inlined to keep this module free of
// cross-imports that might pull in heavy ABI dependencies under test.
const FLAG_ACTIVE = 0x2;
const FLAG_HAS_VOTED = 0x4;
const PHASE_VOTING = 4;
const HEADLESS_STALL_BREAKER_ROUNDS = 3;

/** Single VOTING_STARTED event shape (mirrors events.ts; relisted to avoid import cycle). */
export interface VotingStartedEvent {
  type: "VOTING_STARTED";
  chainId: number;
  roomId: string;
  phaseId: string;
  dayNumber: number;
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
}

export interface RoomSnapshot {
  phase: number;
  dayCount: number;
  aliveCount: number;
  /** Unix seconds; used by the agent phase-timeout driver. Optional for test mocks. */
  phaseDeadline?: number;
}

export interface PlayerSnapshot {
  wallet: Address;
  flags: number;
  /** On-chain display nickname (set at joinRoom). Reliable name source for prompts. */
  nickname?: string;
}

/**
 * Chain-side operations the handler needs. A production impl wraps the
 * viem clients from src/chain.ts; tests inject a fake.
 */
export interface VoteChainOps {
  readonly chainId: number;
  readonly diamond: Hex;
  /** Used to subscribe to ResultReady for inferString. */
  publicClient: PublicClient;
  getRoom(roomId: bigint): Promise<RoomSnapshot>;
  getPlayers(roomId: bigint): Promise<readonly PlayerSnapshot[]>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  /** Already-committed traceCommitment for this slot, or zeroes if none. */
  getAgentTraceCommitment(
    roomId: bigint,
    phaseId: Hex,
    agent: Address
  ): Promise<Hex>;
  sendVote(
    agent: HDAccount,
    roomId: bigint,
    target: Address,
    gasPriceGwei: number
  ): Promise<Hex>;
  sendCommitInference(
    agent: HDAccount,
    roomId: bigint,
    phaseId: Hex,
    actionHash: Hex,
    traceCommitment: Hex,
    gasPriceGwei: number
  ): Promise<Hex>;
  /** Build a WalletClient bound to this agent EOA. Used to drive inferString. */
  buildAgentWalletClient(agent: HDAccount): WalletClient;
}

export type InferFn = typeof defaultInferFn;

export interface VotingHandlerDeps {
  redis: Redis;
  /** Resolves chain-side ops for a given chainId. Production: built from src/chain.ts. */
  chainOpsFor(chainId: number): VoteChainOps;
  /** Mnemonic for HD-deriving agent EOAs. Use loadOrGenerateMnemonic() at boot. */
  mnemonic: string;
  /** Upper bound on candidate wallets to derive per room (default 6, matches 6-player rooms). */
  maxAgentsPerRoom?: number;
  /** Override default 25s LLM wait — leaves ~5s within the 30s voting window for the vote tx. */
  llmWaitMs?: number;
  /** Override default gas price for inferString deposit. */
  llmGasPriceGwei?: number;
  /** Override default gas price for vote / commit tx. */
  txGasPriceGwei?: number;
  /** Chat history provider for the prompt. Optional — defaults to empty array (4d wires this). */
  chatHistoryFor?: (
    chainId: number,
    roomId: string,
    dayNumber: number
  ) => Promise<{ from: Address; text: string }[]>;
  /** Private verified facts for this agent (detective results, later audit facts). */
  memoryFor?: (
    chainId: number,
    roomId: string,
    agent: Address
  ) => Promise<string[]>;
  /** Agent language override (defaults to "English"). */
  language?: string;
  /** Inject a fake inferString for tests. */
  inferFn?: InferFn;
  /**
   * Per-agent pre-inference funding gate. Returns true if the agent EOA holds
   * enough to pay an inference deposit (topping up from the sponsor if needed),
   * false if it could not be funded (sponsor at floor). Unset → no gate.
   */
  ensureFunded?: (chainId: number, agent: Address) => Promise<boolean>;
  /**
   * Inter-agent vote delay (ms) applied ONLY in headless games (no alive human):
   * staggers the otherwise-parallel votes so a spectator sees them trickle in
   * instead of all landing at once + an instant flip to NIGHT. Mixed games keep
   * the parallel path (must fit the voting window). Default 0 (no stagger).
   */
  voteStaggerMs?: number;
  /** Injectable delay for tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AgentVoteOutcome {
  agent: Address;
  status:
    | "voted"
    | "skipped-not-active"
    | "skipped-already-voted"
    | "skipped-action-idempotent"
    | "skipped-already-committed"
    | "skipped-no-targets"
    | "skipped-unfunded"
    | "vote-failed"
    | "commit-failed";
  voteTxHash?: Hex;
  commitTxHash?: Hex;
  llmTxHash?: Hex;
  decisionSource?: "llm" | "fallback";
  target?: Address;
  err?: string;
}

export class VotingHandler {
  private readonly maxAgents: number;
  private readonly llmWaitMs: number;
  private readonly llmGasPriceGwei: number;
  private readonly txGasPriceGwei: number;
  private readonly inferFn: InferFn;
  private readonly language: string;
  private readonly chatHistoryFor: NonNullable<
    VotingHandlerDeps["chatHistoryFor"]
  >;
  private readonly memoryFor: NonNullable<VotingHandlerDeps["memoryFor"]>;
  private readonly voteStaggerMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: VotingHandlerDeps) {
    this.maxAgents = deps.maxAgentsPerRoom ?? 6;
    this.voteStaggerMs = deps.voteStaggerMs ?? 0;
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // 25s default leaves ~5s of the 30s voting window for the vote tx.
    this.llmWaitMs = deps.llmWaitMs ?? 25_000;
    this.llmGasPriceGwei = deps.llmGasPriceGwei ?? 10;
    this.txGasPriceGwei = deps.txGasPriceGwei ?? 10;
    this.inferFn = deps.inferFn ?? defaultInferFn;
    this.language = deps.language ?? "English";
    this.chatHistoryFor =
      deps.chatHistoryFor ??
      ((chainId, roomId) =>
        loadRecentPromptChat(this.deps.redis, chainId, roomId));
    this.memoryFor =
      deps.memoryFor ??
      ((chainId, roomId, agent) =>
        loadMemoryPromptLines(this.deps.redis, chainId, roomId, agent));
  }

  async handle(event: VotingStartedEvent): Promise<AgentVoteOutcome[]> {
    const chain = this.deps.chainOpsFor(event.chainId);
    const roomIdBig = BigInt(event.roomId);
    const log = logger.child({
      mod: "agents/voting",
      chainId: event.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      dayNumber: event.dayNumber,
    });

    const room = await chain.getRoom(roomIdBig).catch((err) => {
      log.error({ err }, "[agents/voting] getRoom failed");
      return null;
    });
    if (!room) return [];
    if (room.phase !== PHASE_VOTING) {
      log.warn(
        { phase: room.phase },
        "[agents/voting] room not in VOTING phase on event delivery — skipping"
      );
      return [];
    }

    const players = await chain.getPlayers(roomIdBig);
    const aliveAddrs = players
      .filter((p) => (p.flags & FLAG_ACTIVE) !== 0)
      .map((p) => p.wallet);

    // Find which alive players are agents we control. The isAgent calls are
    // small, so a Promise.all is fine; for 6-player rooms this is at most 6 RPCs.
    const isAgentResults = await Promise.all(
      aliveAddrs.map((a) =>
        chain
          .isAgent(roomIdBig, a)
          .then((flag) => ({ addr: a, flag }))
          .catch(() => ({ addr: a, flag: false }))
      )
    );
    const onChainAgentSet = isAgentResults
      .filter((r) => r.flag)
      .map((r) => r.addr);

    if (onChainAgentSet.length === 0) {
      log.info("[agents/voting] no agents in room — nothing to do");
      return [];
    }

    const myAgents = matchWalletsToAgents(
      this.deps.mnemonic,
      roomIdBig,
      onChainAgentSet,
      this.maxAgents
    );
    if (myAgents.length === 0) {
      log.warn(
        { onChainAgentSet, derivedCount: this.maxAgents },
        "[agents/voting] none of the on-chain agents match our HD mnemonic — different gm instance or wrong mnemonic in env"
      );
      return [];
    }

    log.info(
      { agents: myAgents.map((w) => w.address) },
      `[agents/voting] dispatching ${myAgents.length} agent vote(s)`
    );

    const playersByAddr = new Map(
      players.map((p) => [p.wallet.toLowerCase(), p] as const)
    );

    // Headless (no alive human) → stagger votes so a spectator can watch them
    // arrive; mixed games keep the parallel path (must fit the voting window).
    const headless = isAgentResults.every((r) => r.flag);
    const staggerMs = headless ? this.voteStaggerMs : 0;

    // Parallel: voting window is 30s, sequential N*LLM_LATENCY won't fit. In
    // headless we offset each agent's START by staggerMs*index (still concurrent,
    // just spread) — bounded well under the voting deadline.
    const outcomes = await Promise.all(
      myAgents.map((wallet, i) =>
        (async () => {
          if (staggerMs > 0 && i > 0) await this.sleep(staggerMs * i);
          return this.handleOneAgent({
            chain,
            wallet,
            roomIdBig,
            event,
            dayCount: room.dayCount,
            allAlive: aliveAddrs,
            playerByAddr: playersByAddr,
            headless,
          });
        })().catch((err) => {
          log.error(
            { err, agent: wallet.address },
            "[agents/voting] handleOneAgent threw"
          );
          return {
            agent: wallet.address,
            status: "vote-failed",
            err: String(err?.message ?? err),
          } as AgentVoteOutcome;
        })
      )
    );

    log.info(
      { outcomes: outcomes.map((o) => ({ a: o.agent, s: o.status })) },
      "[agents/voting] done"
    );
    return outcomes;
  }

  private async handleOneAgent(args: {
    chain: VoteChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: VotingStartedEvent;
    dayCount: number;
    allAlive: Address[];
    playerByAddr: Map<string, PlayerSnapshot>;
    headless: boolean;
  }): Promise<AgentVoteOutcome> {
    const { chain, wallet, roomIdBig, event, dayCount, allAlive, playerByAddr, headless } =
      args;
    const log = logger.child({
      mod: "agents/voting",
      chainId: chain.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      agent: wallet.address,
    });

    // 1. On-chain state checks — skip cheap reasons before spending on LLM call.
    const myRow = playerByAddr.get(wallet.address.toLowerCase());
    if (!myRow || (myRow.flags & FLAG_ACTIVE) === 0) {
      log.info("[agents/voting] agent not active in room — skipping");
      return { agent: wallet.address, status: "skipped-not-active" };
    }
    if ((myRow.flags & FLAG_HAS_VOTED) !== 0) {
      log.info("[agents/voting] HAS_VOTED already set on chain — skipping");
      return { agent: wallet.address, status: "skipped-already-voted" };
    }
    // No valid targets — only self is alive (game effectively over). Avoid
    // spending the inferString deposit and bypass resolveDecision's throw path.
    const validTargets = allAlive.filter(
      (a) => a.toLowerCase() !== wallet.address.toLowerCase()
    );
    if (validTargets.length === 0) {
      log.warn(
        { allAlive },
        "[agents/voting] only self is alive — no vote target available"
      );
      return { agent: wallet.address, status: "skipped-no-targets" };
    }

    // 2. Action idempotency. If we've started/finished this slot before, skip.
    const actionKey = agentActionProcessedKey(
      chain.chainId,
      event.roomId,
      event.phaseId,
      wallet.address,
      "vote"
    );
    const claimed = await this.deps.redis.set(
      actionKey,
      JSON.stringify({ startedAt: Date.now() }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS,
      "NX"
    );
    if (claimed !== "OK") {
      log.info("[agents/voting] action key already held — skipping");
      return { agent: wallet.address, status: "skipped-action-idempotent" };
    }

    // 3. Belt + braces: if a commitment for this slot already exists on chain
    // (a stale Redis or fresh deploy could let us pass step 2), skip the work.
    const phaseIdHex = makePhaseId("VOTING", dayCount);
    const existingCommit = await chain.getAgentTraceCommitment(
      roomIdBig,
      phaseIdHex,
      wallet.address
    );
    if (existingCommit !== ZERO_BYTES32) {
      log.info(
        { existingCommit },
        "[agents/voting] trace already committed on chain — skipping"
      );
      return { agent: wallet.address, status: "skipped-already-committed" };
    }

    // 3b. Per-agent funding gate — top up from the sponsor before paying the
    // inference deposit so a depleted EOA doesn't revert createRequest (which
    // dropped the agent to a fallback vote with no LLM reasoning). See
    // agent-funding.ensureAgentFunded.
    if (this.deps.ensureFunded) {
      const funded = await this.deps
        .ensureFunded(chain.chainId, wallet.address)
        .catch((err: any) => {
          log.warn(
            { err: String(err?.message ?? err) },
            "[agents/voting] ensureFunded threw — proceeding best-effort"
          );
          return true;
        });
      if (!funded) {
        log.warn(
          "[agents/voting] agent wallet unfunded and sponsor at floor — skipping"
        );
        return { agent: wallet.address, status: "skipped-unfunded" };
      }
    }

    // 4. Build the prompt + run inferString.
    const chatHistory = await this.chatHistoryFor(
      chain.chainId,
      event.roomId,
      dayCount
    ).catch(() => []);
    const privateMemory = await this.memoryFor(
      chain.chainId,
      event.roomId,
      wallet.address
    ).catch(() => []);
    const nameOf = (addr: string) => {
      const nick = playerByAddr.get(addr.toLowerCase())?.nickname?.trim();
      return nick || `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    };
    const gameContext = await loadPublicGameContext(this.deps.redis, {
      chainId: chain.chainId,
      roomId: event.roomId,
      currentDay: dayCount,
      alive: allAlive,
      self: wallet.address,
      nameOf,
    }).catch(() => ({ lines: [], consensusTarget: null, stalledVoteRounds: 0 }));

    const { prompt, system, allowedValues } = buildVotePrompt({
      self: wallet.address,
      alive: allAlive,
      publicChat: chatHistory,
      privateMemory,
      publicContext: gameContext.lines,
      dayCount,
      language: this.language,
    });

    // The agent EOA itself drives the inferString tx — that wallet pays the
    // deposit. Top-up is 4g's responsibility; for spike/testnet the sponsor
    // pre-funds these EOAs.
    const walletClient = chain.buildAgentWalletClient(wallet.account);

    let infer: InferStringResult;
    try {
      infer = await this.inferFn(
        {
          prompt,
          system,
          chainOfThought: false,
          allowedValues,
        },
        {
          publicClient: chain.publicClient,
          walletClient,
          chainId: chain.chainId,
          waitMs: this.llmWaitMs,
          gasPriceGwei: this.llmGasPriceGwei,
        }
      );
    } catch (err: any) {
      log.error({ err: String(err?.message ?? err) }, "[agents/voting] inferString threw");
      // Release action key — no on-chain action happened yet, so a future
      // re-delivery (listener restart within the voting window) can retry.
      // After the vote tx fires we deliberately keep the key.
      await this.deps.redis.del(actionKey).catch((delErr: any) =>
        log.warn(
          { delErr, actionKey },
          "[agents/voting] failed to release action key after infer fail"
        )
      );
      return {
        agent: wallet.address,
        status: "vote-failed",
        err: String(err?.message ?? err),
      };
    }

    let decision = resolveDecision(infer.text, {
      self: wallet.address,
      alive: allAlive,
      action: "vote",
      fallbackTarget: gameContext.consensusTarget,
    });
    if (
      headless &&
      gameContext.stalledVoteRounds >= HEADLESS_STALL_BREAKER_ROUNDS &&
      gameContext.consensusTarget &&
      decision.target.toLowerCase() !== gameContext.consensusTarget.toLowerCase()
    ) {
      decision = {
        target: gameContext.consensusTarget,
        source: "fallback",
        fallbackReason: `headless stall breaker after ${gameContext.stalledVoteRounds} no-elimination rounds`,
      };
    }

    log.info(
      {
        latencySec: infer.latencySec,
        status: infer.status,
        source: decision.source,
        target: decision.target,
        fallbackReason: decision.fallbackReason,
      },
      `[agents/voting] decision via ${decision.source}`
    );

    // 5. Vote tx (deadline-sensitive; do this first).
    let voteTxHash: Hex;
    try {
      voteTxHash = await chain.sendVote(
        wallet.account,
        roomIdBig,
        decision.target,
        this.txGasPriceGwei
      );
    } catch (err: any) {
      log.error(
        { err: String(err?.message ?? err) },
        "[agents/voting] vote tx failed"
      );
      return {
        agent: wallet.address,
        status: "vote-failed",
        llmTxHash: infer.txHash,
        err: String(err?.message ?? err),
      };
    }
    log.info({ voteTxHash }, "[agents/voting] vote tx sent");

    // 6. Compute trace material + commit.
    const salt = randomSalt();
    const promptHash = keccak256(toHex(prompt));
    const responseHash = keccak256(toHex(infer.text ?? ""));
    const actionHash = voteActionHash(decision.target);
    const traceCommitment = computeTraceCommitment({
      diamond: chain.diamond,
      chainId: BigInt(chain.chainId),
      roomId: roomIdBig,
      phaseId: phaseIdHex,
      agent: wallet.address,
      salt,
      somniaRequestId: infer.requestId,
      promptHash,
      responseHash,
      actionHash,
    });

    let commitTxHash: Hex | undefined;
    try {
      commitTxHash = await chain.sendCommitInference(
        wallet.account,
        roomIdBig,
        phaseIdHex,
        actionHash,
        traceCommitment,
        this.txGasPriceGwei
      );
      log.info({ commitTxHash }, "[agents/voting] commit tx sent");
    } catch (err: any) {
      log.error(
        { err: String(err?.message ?? err) },
        "[agents/voting] commitAgentInference tx failed — trace will still be stored locally for retry"
      );
      // intentionally fall through to persist trace so a retry can re-issue
      // the commit later. Return commit-failed status.
    }

    // 7. Persist full trace privately. Revealed via 4c-reveal flow after GameEnded.
    await this.deps.redis.set(
      agentTraceKey(
        chain.chainId,
        event.roomId,
        event.phaseId,
        wallet.address
      ),
      JSON.stringify({
        salt,
        somniaRequestId: infer.requestId.toString(),
        promptHash,
        responseHash,
        actionHash,
        traceCommitment,
        prompt,
        response: infer.text,
        target: decision.target,
        source: decision.source,
        fallbackReason: decision.fallbackReason,
        llmTxHash: infer.txHash,
        voteTxHash,
        commitTxHash: commitTxHash ?? null,
        committedAt: Date.now(),
      }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS
    );

    return commitTxHash
      ? {
          agent: wallet.address,
          status: "voted",
          voteTxHash,
          commitTxHash,
          llmTxHash: infer.txHash,
          decisionSource: decision.source,
          target: decision.target,
        }
      : {
          agent: wallet.address,
          status: "commit-failed",
          voteTxHash,
          llmTxHash: infer.txHash,
          decisionSource: decision.source,
          target: decision.target,
        };
  }
}

const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Build the canonical actionHash bytes the same way `voteActionHash` does —
 * exposed so audit tools / tests can recompute it without importing the ABI
 * module.
 */
export function computeVoteActionHash(target: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }],
      ["VOTE", target]
    )
  );
}

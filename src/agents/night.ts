/**
 * agents/night.ts — NIGHT phase handler (Task 4f).
 *
 * When the listener emits a NIGHT_STARTED AgentEvent, this handler:
 *   1. Enumerates the agents currently in that room via AgentRegistryFacet.isAgent.
 *   2. For each agent, in parallel:
 *      a. Claims an action-level idempotency slot in Redis. Skip if held.
 *      b. Skips if the agent is not active.
 *      c. Skips if an on-chain trace commitment already exists for the slot.
 *      d. Loads the agent's role from Redis (assigned by GM during setup).
 *         - CITIZEN / no role → commit a deterministic SKIP action (no LLM).
 *         - MAFIA / DOCTOR / DETECTIVE → call Somnia `inferToolsChat` with a
 *           role-gated tool list (mafia sees only mafiaKill, doctor only
 *           doctorHeal, etc).
 *      e. Decodes the LLM's selected tool calldata to extract (action, target).
 *      f. Computes actionHash via registry-abi.nightActionHash.
 *      g. Sends `commitAgentInference` from the agent EOA.
 *      h. Persists the full trace (salt, prompt, response, hashes, tx hashes)
 *         under `agentTraceKey` for post-game reveal.
 *
 * Why no direct on-chain night action tx (unlike voting):
 *   - Per NightFacet.sol header, the night phase is GM-authoritative
 *     (`resolveNightAsGameMaster`). There is no per-player nightKill / heal /
 *     check function on chain. The agent's role-bound tool selection is a
 *     fictional surface fed to the LLM purely so it produces a structured
 *     decision; we decode that decision, commit its hash on chain for audit,
 *     and let the off-chain GM aggregator turn agent decisions into the final
 *     resolveNightAsGameMaster call.
 *
 * Role secrecy ([[agent-role-secrecy]]):
 *   - All agents commit, including citizens (identical-shape footprint).
 *   - traceCommitment is opaque bytes32 mid-game (salt + multi-field keccak).
 *   - Prompt / response / target / role are kept private in Redis until
 *     GameEnded; revealed via 4c-reveal flow.
 */
import type { Redis } from "ioredis";
import {
  decodeAbiParameters,
  parseAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type HDAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Groth16Proof } from "./groth16.js";
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
import {
  inferToolsChatOnSomnia as defaultInferToolsFn,
  type InferToolsChatResult,
  type OnchainTool,
} from "./llm-tools-call.js";
import { matchWalletsToAgents, type AgentWallet } from "./wallets.js";
import {
  nightActionHash,
  type NightActionKind,
} from "./registry-abi.js";
import { AgentRole, getAgentRole, roleLabel } from "./roles.js";
import type {
  AgentNightActionRecord,
  AgentNightActionRecordResult,
  GmNightActionType,
} from "./night-action-bridge.js";

const FLAG_ACTIVE = 0x2;
const PHASE_NIGHT = 5;
const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Mirrors events.ts; relisted to avoid import cycle. */
export interface NightStartedEvent {
  type: "NIGHT_STARTED";
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
}

export interface PlayerSnapshot {
  wallet: Address;
  flags: number;
}

/**
 * Chain-side ops the handler needs. Structurally a subset of VoteChainOps so
 * the same makeVoteChainOps factory satisfies both.
 */
export interface NightChainOps {
  readonly chainId: number;
  readonly diamond: Hex;
  publicClient: PublicClient;
  getRoom(roomId: bigint): Promise<RoomSnapshot>;
  getPlayers(roomId: bigint): Promise<readonly PlayerSnapshot[]>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  getAgentTraceCommitment(
    roomId: bigint,
    phaseId: Hex,
    agent: Address
  ): Promise<Hex>;
  sendCommitInference(
    agent: HDAccount,
    roomId: bigint,
    phaseId: Hex,
    actionHash: Hex,
    traceCommitment: Hex,
    gasPriceGwei: number
  ): Promise<Hex>;
  buildAgentWalletClient(agent: HDAccount): WalletClient;
  endGameZKAsAgent(roomId: bigint, proof: Groth16Proof, agent: HDAccount): Promise<{ hash: Hex }>;
}

export type InferToolsFn = typeof defaultInferToolsFn;

export interface NightHandlerDeps {
  redis: Redis;
  chainOpsFor(chainId: number): NightChainOps;
  mnemonic: string;
  maxAgentsPerRoom?: number;
  /** Override default 60s LLM wait — NIGHT is more relaxed than the 30s vote window. */
  llmWaitMs?: number;
  llmGasPriceGwei?: number;
  txGasPriceGwei?: number;
  /** Background commit retry budget (tests inject tiny delays). */
  nightCommitMaxAttempts?: number;
  nightCommitRetryDelayMs?: number;
  language?: string;
  /** Inject a fake inferToolsChat for tests. */
  inferToolsFn?: InferToolsFn;
  /** Optional bridge into the GM night-state aggregator. */
  recordNightAction?: (
    record: AgentNightActionRecord
  ) => Promise<AgentNightActionRecordResult | void>;
}

export type NightOutcomeStatus =
  | "committed"
  | "recorded"
  | "record-failed"
  | "skipped-not-active"
  | "skipped-action-idempotent"
  | "skipped-already-committed"
  | "infer-failed"
  | "decode-failed"
  | "commit-failed";

export interface AgentNightOutcome {
  agent: Address;
  status: NightOutcomeStatus;
  role?: AgentRole;
  action?: NightActionKind;
  target?: Address;
  commitTxHash?: Hex;
  llmTxHash?: Hex;
  decisionSource?: "llm" | "fallback" | "skip";
  nightActionRecorded?: boolean;
  err?: string;
}

/**
 * Fictional role-bound tool surface. Signatures fed to the LLM so it produces
 * structured calldata; no contract function with these selectors exists. Per
 * memory [[4e-tools-smoke-done]] viem expects (string,string) tuples.
 */
const ROLE_TOOLS: Record<Exclude<AgentRole, AgentRole.NONE | AgentRole.CITIZEN>, OnchainTool[]> = {
  [AgentRole.MAFIA]: [
    {
      signature: "mafiaKill(address)",
      description:
        "Choose one alive player (not yourself) to eliminate tonight. Argument: their wallet address.",
    },
  ],
  [AgentRole.DOCTOR]: [
    {
      signature: "doctorHeal(address)",
      description:
        "Choose one alive player to protect from the mafia tonight. You may protect yourself.",
    },
  ],
  [AgentRole.DETECTIVE]: [
    {
      signature: "detectiveCheck(address)",
      description:
        "Choose one alive player (not yourself) to investigate. The narrator will privately tell you whether they are mafia.",
    },
  ],
};

/** Selector → (action kind, allow-self) mapping. */
interface ToolMeta {
  kind: NightActionKind;
  allowSelf: boolean;
}
// Selectors derived at module load; toFunctionSelector imported lazily to avoid
// pulling viem at top — but we already import elsewhere so just compute inline.
import { toFunctionSelector } from "viem";
const SELECTOR_META: Record<string, ToolMeta> = {
  [toFunctionSelector("mafiaKill(address)").toLowerCase()]: {
    kind: "KILL",
    allowSelf: false,
  },
  [toFunctionSelector("doctorHeal(address)").toLowerCase()]: {
    kind: "HEAL",
    allowSelf: true,
  },
  [toFunctionSelector("detectiveCheck(address)").toLowerCase()]: {
    kind: "CHECK",
    allowSelf: false,
  },
};

export interface NightDecision {
  kind: NightActionKind;
  target: Address;
  source: "llm" | "fallback";
  fallbackReason?: string;
}

/**
 * Decode a `pendingToolCalls[0]` blob into a (kind, target) decision. Falls
 * back to a deterministic lowest-address pick if the calldata is malformed or
 * the LLM picked an unexpected selector / off-pool target.
 */
export function decodeNightToolCall(
  calldata: Hex | null | undefined,
  role: AgentRole,
  self: Address,
  pool: readonly Address[]
): NightDecision {
  const expected = ROLE_TOOLS[role as keyof typeof ROLE_TOOLS];
  // Should never happen if caller guards role first, but stay defensive.
  if (!expected || expected.length === 0) {
    return {
      kind: "SKIP",
      target: ZERO_ADDR,
      source: "fallback",
      fallbackReason: "no role tools for this role",
    };
  }
  const expectedKind = SELECTOR_META[
    toFunctionSelector(expected[0].signature).toLowerCase()
  ].kind;
  const meta = SELECTOR_META[
    toFunctionSelector(expected[0].signature).toLowerCase()
  ];

  if (!calldata || calldata.length < 10) {
    return {
      kind: expectedKind,
      target: deterministicPick(pool, self, meta.allowSelf),
      source: "fallback",
      fallbackReason: "LLM returned no calldata",
    };
  }

  const selector = calldata.slice(0, 10).toLowerCase();
  const selMeta = SELECTOR_META[selector];

  // Off-script selector: hash to expected role's action with fallback target.
  if (!selMeta || selMeta.kind !== expectedKind) {
    return {
      kind: expectedKind,
      target: deterministicPick(pool, self, meta.allowSelf),
      source: "fallback",
      fallbackReason: `LLM selector ${selector} != expected ${expectedKind}`,
    };
  }

  let parsedTarget: Address;
  try {
    const argsHex = ("0x" + calldata.slice(10)) as Hex;
    [parsedTarget] = decodeAbiParameters(
      parseAbiParameters("address"),
      argsHex
    ) as [Address];
  } catch (err) {
    return {
      kind: expectedKind,
      target: deterministicPick(pool, self, meta.allowSelf),
      source: "fallback",
      fallbackReason: `decode failed: ${(err as Error).message}`,
    };
  }

  // Validate target is in pool (alive, +/- self allowed depending on action).
  const allowed = filterPool(pool, self, meta.allowSelf);
  const match = allowed.find(
    (a) => a.toLowerCase() === parsedTarget.toLowerCase()
  );
  if (!match) {
    return {
      kind: expectedKind,
      target: deterministicPick(pool, self, meta.allowSelf),
      source: "fallback",
      fallbackReason: `target ${parsedTarget} not in allowed pool (${allowed.length} candidates)`,
    };
  }

  return { kind: expectedKind, target: match, source: "llm" };
}

function filterPool(
  pool: readonly Address[],
  self: Address,
  allowSelf: boolean
): Address[] {
  return pool.filter((a) =>
    allowSelf ? true : a.toLowerCase() !== self.toLowerCase()
  );
}

function deterministicPick(
  pool: readonly Address[],
  self: Address,
  allowSelf: boolean
): Address {
  const filtered = filterPool(pool, self, allowSelf);
  if (filtered.length === 0) return ZERO_ADDR;
  return [...filtered].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : 1
  )[0];
}

function toGmNightAction(kind: NightActionKind): GmNightActionType {
  switch (kind) {
    case "KILL":
      return "kill";
    case "HEAL":
      return "heal";
    case "CHECK":
      return "check";
    default:
      return "skip";
  }
}

export interface NightPromptArgs {
  self: Address;
  role: AgentRole;
  alive: Address[];
  dayCount: number;
  language: string;
}

export function buildNightPrompt(args: NightPromptArgs): {
  roles: string[];
  messages: string[];
  tools: OnchainTool[];
} {
  const others = args.alive.filter(
    (a) => a.toLowerCase() !== args.self.toLowerCase()
  );
  const role = args.role;
  const persona =
    role === AgentRole.MAFIA
      ? `You are the mafia. Pick one alive non-mafia player to eliminate tonight.`
      : role === AgentRole.DOCTOR
      ? `You are the doctor. Pick one alive player (possibly yourself) to protect from the mafia tonight.`
      : `You are the detective. Pick one alive non-self player to investigate tonight.`;

  const tools = ROLE_TOOLS[role as keyof typeof ROLE_TOOLS] ?? [];

  return {
    roles: ["system", "user"],
    messages: [
      [
        persona,
        `You MUST call exactly one of the provided tools with the wallet address of your chosen player.`,
        `Reply language for any reasoning: ${args.language}.`,
        `Do not reveal your role to other players.`,
      ].join(" "),
      [
        `Night ${args.dayCount}. Your wallet: ${args.self}.`,
        `Alive players${role === AgentRole.DOCTOR ? "" : " (not you)"}: ${
          (role === AgentRole.DOCTOR ? args.alive : others).join(", ")
        }`,
        ``,
        `Pick one target by calling the tool.`,
      ].join("\n"),
    ],
    tools,
  };
}

export class NightHandler {
  private readonly maxAgents: number;
  private readonly llmWaitMs: number;
  private readonly llmGasPriceGwei: number;
  private readonly txGasPriceGwei: number;
  private readonly nightCommitMaxAttempts: number;
  private readonly nightCommitRetryDelayMs: number;
  private readonly inferToolsFn: InferToolsFn;
  private readonly language: string;
  /** In-flight background commits, tracked for tests + graceful shutdown. */
  private readonly pendingCommits = new Set<Promise<void>>();

  constructor(private readonly deps: NightHandlerDeps) {
    this.maxAgents = deps.maxAgentsPerRoom ?? 6;
    this.llmWaitMs = deps.llmWaitMs ?? 60_000;
    this.llmGasPriceGwei = deps.llmGasPriceGwei ?? 10;
    this.txGasPriceGwei = deps.txGasPriceGwei ?? 10;
    this.nightCommitMaxAttempts = deps.nightCommitMaxAttempts ?? 3;
    this.nightCommitRetryDelayMs = deps.nightCommitRetryDelayMs ?? 4_000;
    this.inferToolsFn = deps.inferToolsFn ?? defaultInferToolsFn;
    this.language = deps.language ?? "English";
  }

  private async recordNightActionSafe(
    record: AgentNightActionRecord,
    log: typeof logger
  ): Promise<boolean> {
    if (!this.deps.recordNightAction) return false;
    try {
      const result = await this.deps.recordNightAction(record);
      return result?.recorded ?? true;
    } catch (err: any) {
      log.error(
        { err: String(err?.message ?? err), action: record.actionType, target: record.targetAddress },
        "[agents/night] failed to bridge action into GM night state"
      );
      return false;
    }
  }

  /**
   * Fire commitAgentInference in the BACKGROUND with bounded retry. The night
   * action is already bridged into GM state + persisted, so a slow/stuck commit
   * (prod room 34 D1: receipt timeout from vote/night tx contention) can no
   * longer drop the kill. On success the persisted trace is patched with the
   * real commitTxHash; on exhaustion commitTxHash stays null for a later
   * replay/sweep. Never throws. Tracked so tests / shutdown can drain via
   * waitForBackgroundCommits().
   */
  private fireCommitInBackground(args: {
    chain: NightChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: NightStartedEvent;
    phaseIdHex: Hex;
    actionHash: Hex;
    traceCommitment: Hex;
    log: typeof logger;
  }): void {
    const p = this.commitTraceWithRetry(args).finally(() => {
      this.pendingCommits.delete(p);
    });
    this.pendingCommits.add(p);
  }

  private async commitTraceWithRetry(args: {
    chain: NightChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: NightStartedEvent;
    phaseIdHex: Hex;
    actionHash: Hex;
    traceCommitment: Hex;
    log: typeof logger;
  }): Promise<void> {
    const { chain, wallet, roomIdBig, event, phaseIdHex, actionHash, traceCommitment, log } = args;
    for (let attempt = 1; attempt <= this.nightCommitMaxAttempts; attempt++) {
      try {
        const commitTxHash = await chain.sendCommitInference(
          wallet.account,
          roomIdBig,
          phaseIdHex,
          actionHash,
          traceCommitment,
          this.txGasPriceGwei
        );
        log.info({ commitTxHash, attempt }, "[agents/night] commit tx confirmed (background)");
        await this.patchTraceCommit(chain.chainId, event, wallet.address, commitTxHash, log);
        return;
      } catch (err: any) {
        const last = attempt >= this.nightCommitMaxAttempts;
        log[last ? "error" : "warn"](
          { err: String(err?.message ?? err), attempt },
          last
            ? "[agents/night] commit gave up after retries — action stands, on-chain trace incomplete"
            : "[agents/night] commit attempt failed — retrying in background"
        );
        if (!last) {
          await new Promise((r) => setTimeout(r, this.nightCommitRetryDelayMs * attempt));
        }
      }
    }
  }

  /** Patch the persisted trace with the real commitTxHash once it lands. */
  private async patchTraceCommit(
    chainId: number,
    event: NightStartedEvent,
    addr: Address,
    commitTxHash: Hex,
    log: typeof logger
  ): Promise<void> {
    try {
      const key = agentTraceKey(chainId, event.roomId, event.phaseId, addr);
      const raw = await this.deps.redis.get(key);
      if (!raw) return;
      const trace = JSON.parse(raw);
      trace.commitTxHash = commitTxHash;
      trace.committedAt = Date.now();
      await this.deps.redis.set(key, JSON.stringify(trace), "EX", IDEMPOTENCY_TTL_SECONDS);
    } catch (err: any) {
      log.warn(
        { err: String(err?.message ?? err) },
        "[agents/night] could not patch trace with commitTxHash"
      );
    }
  }

  /** Await all in-flight background commits (tests + graceful shutdown). */
  async waitForBackgroundCommits(): Promise<void> {
    await Promise.allSettled([...this.pendingCommits]);
  }

  private async replayNightActionFromTrace(args: {
    chain: NightChainOps;
    wallet: AgentWallet;
    event: NightStartedEvent;
    dayCount: number;
    log: typeof logger;
  }): Promise<boolean> {
    if (!this.deps.recordNightAction) return false;
    const raw = await this.deps.redis.get(
      agentTraceKey(
        args.chain.chainId,
        args.event.roomId,
        args.event.phaseId,
        args.wallet.address
      )
    );
    if (!raw) return false;
    try {
      const trace = JSON.parse(raw) as {
        action?: NightActionKind;
        target?: Address;
        source?: string;
        commitTxHash?: Hex | null;
      };
      if (!trace.action || !trace.target) return false;
      return this.recordNightActionSafe(
        {
          chainId: args.chain.chainId,
          roomId: args.event.roomId,
          dayCount: args.dayCount,
          playerAddress: args.wallet.address,
          actionType: toGmNightAction(trace.action),
          targetAddress: trace.target,
          source: trace.source,
          commitTxHash: trace.commitTxHash,
        },
        args.log
      );
    } catch (err: any) {
      args.log.warn(
        { err: String(err?.message ?? err) },
        "[agents/night] could not replay bridged night action from trace"
      );
      return false;
    }
  }

  async handle(event: NightStartedEvent): Promise<AgentNightOutcome[]> {
    const chain = this.deps.chainOpsFor(event.chainId);
    const roomIdBig = BigInt(event.roomId);
    const log = logger.child({
      mod: "agents/night",
      chainId: event.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      dayNumber: event.dayNumber,
    });

    const room = await chain.getRoom(roomIdBig).catch((err) => {
      log.error({ err }, "[agents/night] getRoom failed");
      return null;
    });
    if (!room) return [];
    if (room.phase !== PHASE_NIGHT) {
      log.warn(
        { phase: room.phase },
        "[agents/night] room not in NIGHT phase on event delivery — skipping"
      );
      return [];
    }

    const players = await chain.getPlayers(roomIdBig);
    const aliveAddrs = players
      .filter((p) => (p.flags & FLAG_ACTIVE) !== 0)
      .map((p) => p.wallet);

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
      log.info("[agents/night] no agents in room — nothing to do");
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
        { onChainAgentSet },
        "[agents/night] none of the on-chain agents match our HD mnemonic"
      );
      return [];
    }

    log.info(
      { agents: myAgents.map((w) => w.address) },
      `[agents/night] dispatching ${myAgents.length} agent night-action(s)`
    );

    const playersByAddr = new Map(
      players.map((p) => [p.wallet.toLowerCase(), p] as const)
    );

    const outcomes = await Promise.all(
      myAgents.map((wallet) =>
        this.handleOneAgent({
          chain,
          wallet,
          roomIdBig,
          event,
          dayCount: room.dayCount,
          allAlive: aliveAddrs,
          playerByAddr: playersByAddr,
        }).catch((err): AgentNightOutcome => {
          log.error(
            { err, agent: wallet.address },
            "[agents/night] handleOneAgent threw"
          );
          return {
            agent: wallet.address,
            status: "commit-failed",
            err: String(err?.message ?? err),
          };
        })
      )
    );

    log.info(
      { outcomes: outcomes.map((o) => ({ a: o.agent, s: o.status, r: o.role })) },
      "[agents/night] done"
    );
    return outcomes;
  }

  private async handleOneAgent(args: {
    chain: NightChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: NightStartedEvent;
    dayCount: number;
    allAlive: Address[];
    playerByAddr: Map<string, PlayerSnapshot>;
  }): Promise<AgentNightOutcome> {
    const { chain, wallet, roomIdBig, event, dayCount, allAlive, playerByAddr } =
      args;
    const log = logger.child({
      mod: "agents/night",
      chainId: chain.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      agent: wallet.address,
    });

    // 1. Active check.
    const myRow = playerByAddr.get(wallet.address.toLowerCase());
    if (!myRow || (myRow.flags & FLAG_ACTIVE) === 0) {
      log.info("[agents/night] agent not active in room — skipping");
      return { agent: wallet.address, status: "skipped-not-active" };
    }

    // 2. Action-level idempotency.
    const actionKey = agentActionProcessedKey(
      chain.chainId,
      event.roomId,
      event.phaseId,
      wallet.address,
      "night"
    );
    const claimed = await this.deps.redis.set(
      actionKey,
      JSON.stringify({ startedAt: Date.now() }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS,
      "NX"
    );
    if (claimed !== "OK") {
      log.info("[agents/night] action key already held — skipping");
      const replayed = await this.replayNightActionFromTrace({
        chain,
        wallet,
        event,
        dayCount,
        log,
      });
      return {
        agent: wallet.address,
        status: "skipped-action-idempotent",
        nightActionRecorded: replayed,
      };
    }

    // 3. On-chain commitment existence check (belt + braces).
    const phaseIdHex = makePhaseId("NIGHT", dayCount);
    const existingCommit = await chain.getAgentTraceCommitment(
      roomIdBig,
      phaseIdHex,
      wallet.address
    );
    if (existingCommit !== ZERO_BYTES32) {
      log.info(
        { existingCommit },
        "[agents/night] trace already committed on chain — skipping"
      );
      const replayed = await this.replayNightActionFromTrace({
        chain,
        wallet,
        event,
        dayCount,
        log,
      });
      return {
        agent: wallet.address,
        status: "skipped-already-committed",
        nightActionRecorded: replayed,
      };
    }

    // 4. Load role. Citizens / unassigned → deterministic SKIP path.
    const role = await getAgentRole(
      this.deps.redis,
      chain.chainId,
      event.roomId,
      wallet.address
    );

    if (
      role === AgentRole.NONE ||
      role === AgentRole.CITIZEN ||
      !ROLE_TOOLS[role as keyof typeof ROLE_TOOLS]
    ) {
      return this.handleSkipPath({
        chain,
        wallet,
        roomIdBig,
        event,
        phaseIdHex,
        role,
        actionKey,
      });
    }

    // 5. Active role — run inferToolsChat with role-gated tool list.
    return this.handleActiveRolePath({
      chain,
      wallet,
      roomIdBig,
      event,
      dayCount,
      phaseIdHex,
      role,
      allAlive,
      actionKey,
    });
  }

  private async handleSkipPath(args: {
    chain: NightChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: NightStartedEvent;
    phaseIdHex: Hex;
    role: AgentRole;
    actionKey: string;
  }): Promise<AgentNightOutcome> {
    const { chain, wallet, roomIdBig, event, phaseIdHex, role } = args;
    const log = logger.child({
      mod: "agents/night",
      chainId: chain.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      agent: wallet.address,
    });

    // No LLM call. actionHash uses ZERO target; salt randomised for opacity.
    const salt = randomSalt();
    const actionHash = nightActionHash("SKIP", ZERO_ADDR);
    const traceCommitment = computeTraceCommitment({
      diamond: chain.diamond,
      chainId: BigInt(chain.chainId),
      roomId: roomIdBig,
      phaseId: phaseIdHex,
      agent: wallet.address,
      salt,
      somniaRequestId: 0n,
      promptHash: ZERO_BYTES32,
      responseHash: ZERO_BYTES32,
      actionHash,
    });

    // Persist trace first, then record the skip into GM state, then commit on
    // chain in the background — same ordering as the active-role path so a slow
    // commit never blocks or drops the night turn.
    await this.deps.redis.set(
      agentTraceKey(
        chain.chainId,
        event.roomId,
        event.phaseId,
        wallet.address
      ),
      JSON.stringify({
        salt,
        somniaRequestId: "0",
        promptHash: ZERO_BYTES32,
        responseHash: ZERO_BYTES32,
        actionHash,
        traceCommitment,
        role,
        action: "SKIP",
        target: ZERO_ADDR,
        source: "skip",
        commitTxHash: null,
        committedAt: Date.now(),
      }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS
    );

    const nightActionRecorded = await this.recordNightActionSafe(
      {
        chainId: chain.chainId,
        roomId: event.roomId,
        dayCount: event.dayNumber,
        playerAddress: wallet.address,
        actionType: "skip",
        targetAddress: ZERO_ADDR,
        source: "skip",
        commitTxHash: null,
      },
      log
    );

    this.fireCommitInBackground({
      chain,
      wallet,
      roomIdBig,
      event,
      phaseIdHex,
      actionHash,
      traceCommitment,
      log,
    });

    return {
      agent: wallet.address,
      status: nightActionRecorded ? "recorded" : "record-failed",
      role,
      action: "SKIP",
      target: ZERO_ADDR,
      decisionSource: "skip",
      nightActionRecorded,
    };
  }

  private async handleActiveRolePath(args: {
    chain: NightChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: NightStartedEvent;
    dayCount: number;
    phaseIdHex: Hex;
    role: AgentRole;
    allAlive: Address[];
    actionKey: string;
  }): Promise<AgentNightOutcome> {
    const {
      chain,
      wallet,
      roomIdBig,
      event,
      dayCount,
      phaseIdHex,
      role,
      allAlive,
      actionKey,
    } = args;
    const log = logger.child({
      mod: "agents/night",
      chainId: chain.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      agent: wallet.address,
    });

    const { roles, messages, tools } = buildNightPrompt({
      self: wallet.address,
      role,
      alive: allAlive,
      dayCount,
      language: this.language,
    });

    const walletClient = chain.buildAgentWalletClient(wallet.account);

    let infer: InferToolsChatResult;
    try {
      infer = await this.inferToolsFn(
        {
          roles,
          messages,
          mcpServerUrls: [],
          onchainTools: tools,
          maxIterations: 1,
          chainOfThought: false,
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
      log.error(
        { err: String(err?.message ?? err) },
        "[agents/night] inferToolsChat threw"
      );
      // No on-chain tx yet — release action key so a retry can fire.
      await this.deps.redis.del(actionKey).catch(() => undefined);
      return {
        agent: wallet.address,
        status: "infer-failed",
        role,
        err: String(err?.message ?? err),
      };
    }

    const firstCalldata =
      infer.result?.pendingToolCalls && infer.result.pendingToolCalls.length > 0
        ? infer.result.pendingToolCalls[0]
        : null;

    const decision = decodeNightToolCall(
      firstCalldata,
      role,
      wallet.address,
      allAlive
    );

    log.info(
      {
        latencySec: infer.latencySec,
        status: infer.status,
        finishReason: infer.result?.finishReason,
        decisionSource: decision.source,
        action: decision.kind,
        target: decision.target,
        fallbackReason: decision.fallbackReason,
      },
      `[agents/night] decision via ${decision.source}`
    );

    // SKIP path fallthrough if no valid target available at all.
    if (decision.target === ZERO_ADDR) {
      log.warn(
        "[agents/night] no valid target — committing SKIP for this slot"
      );
      decision.kind = "SKIP";
    }

    const salt = randomSalt();
    const promptText = `${roles[0]}: ${messages[0]}\n${roles[1]}: ${messages[1]}`;
    const promptHash = keccak256(toHex(promptText));
    const responseHash = keccak256(
      toHex(firstCalldata ?? infer.result?.response ?? "")
    );
    const actionHash = nightActionHash(decision.kind, decision.target);
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

    // Persist the trace FIRST (commitTxHash filled in later by the background
    // commit). A slow/stuck on-chain commit must never gate the kill.
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
        prompt: promptText,
        responseFinishReason: infer.result?.finishReason ?? null,
        responseText: infer.result?.response ?? null,
        pendingToolCalls: infer.result?.pendingToolCalls ?? [],
        pendingToolCallIds: infer.result?.pendingToolCallIds ?? [],
        role,
        action: decision.kind,
        target: decision.target,
        source: decision.source,
        fallbackReason: decision.fallbackReason,
        llmTxHash: infer.txHash,
        commitTxHash: null,
        committedAt: Date.now(),
      }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS
    );

    // Bridge into GM night-state IMMEDIATELY — this is what doResolveNight reads
    // to set killTarget/healTarget. Gating it on the commit was the prod D1 bug.
    const nightActionRecorded = await this.recordNightActionSafe(
      {
        chainId: chain.chainId,
        roomId: event.roomId,
        dayCount,
        playerAddress: wallet.address,
        actionType: toGmNightAction(decision.kind),
        targetAddress: decision.target,
        source: decision.source,
        commitTxHash: null,
      },
      log
    );

    // On-chain audit commit runs in the background with retry; it can no longer
    // block the night handler or drop the action.
    this.fireCommitInBackground({
      chain,
      wallet,
      roomIdBig,
      event,
      phaseIdHex,
      actionHash,
      traceCommitment,
      log,
    });

    return {
      agent: wallet.address,
      status: nightActionRecorded ? "recorded" : "record-failed",
      role,
      action: decision.kind,
      target: decision.target,
      llmTxHash: infer.txHash,
      decisionSource: decision.source,
      nightActionRecorded,
    };
  }
}

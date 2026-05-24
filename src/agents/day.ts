/**
 * agents/day.ts — DAY phase chat handler (Task 4d).
 *
 * Lifecycle per agent (see docs/superpowers/specs/2026-05-18-4d-day-chat-design.md):
 *   1. Pre-phase + on-chain dedup checks; claim action key.
 *   2. Load role / persona / chat history / alive set.
 *   3. Sponsor budget guard.
 *   4. Persist trace with commitStatus=PENDING_INFERENCE.
 *   5. Build prompt, call inferChat.
 *   6. Scrub → decide msgKind.
 *   7. Compute hashes.
 *   8. F3 second phase recheck.
 *   9. Persist PENDING_COMMIT + send commitAgentMessageV2.
 *  10. On revert: reason-agnostic recovery via getAgentMessageHash
 *      (F-new-round4-1) — branch tri-way on stored hash.
 *  11. On success + msgKind=MSG: append chat + log + WS broadcast (no
 *      somniaRequestId — F-new-2 role-secrecy).
 *
 * Diverges from NIGHT (night.ts):
 *   - INFER_TIMEOUT keeps the action key held (DAY silence is benign).
 *   - SCRUBBED_SKIP still commits a domain-separated SKIP messageHash.
 *   - PHASE_ADVANCED releases the action key (LLM cost already spent).
 *   - Suspicion / ledger updates are driven by chain events elsewhere
 *     (not from the chat content) per F6.
 */
import type { Redis } from "ioredis";
import {
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
  agentChatLogKey,
  agentChatPromptKey,
  agentMessageCommittedKey,
  agentSkipReasonKey,
  agentTraceKey,
  DAY_CHAT_TTL_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
} from "./redis-keys.js";
import { getAgentRole, AgentRole, roleLabel } from "./roles.js";
import { getOrPinPersona } from "./personas.js";
import { scrubText, type ScrubResult } from "./scrubber.js";
import {
  SCRUB_VERSION,
  MSG_KIND_REGULAR,
  MSG_KIND_SKIP_SCRUBBED,
  computeMessageHash,
  messageTextHash,
  canonicalPromptHash,
  randomSalt,
  makePhaseId,
  type CommitStatus,
  type MsgKind,
} from "./trace.js";
import { matchWalletsToAgents, type AgentWallet } from "./wallets.js";
import {
  inferChatOnSomnia as defaultInferChatFn,
  hasUsableChatStore,
  type InferChatResult,
} from "./llm-chat-call.js";
import { loadMemoryPromptLines } from "./memory.js";

const PHASE_DAY = 3; // GamePhase.DAY (was 2/REVEAL — bug: handler skipped every real DAY)
const FLAG_ACTIVE = 0x2;
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const SPONSOR_LOW_THRESHOLD_STT_DEFAULT = 1.5;

export interface DayStartedEvent {
  type: "DAY_STARTED";
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

export interface DayChainOps {
  readonly chainId: number;
  readonly diamond: Hex;
  publicClient: PublicClient;
  getRoom(roomId: bigint): Promise<RoomSnapshot>;
  getPlayers(roomId: bigint): Promise<readonly PlayerSnapshot[]>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  getAgentMessageHash(roomId: bigint, phaseId: Hex, agent: Address): Promise<Hex>;
  sendCommitMessageV2(
    agent: HDAccount,
    roomId: bigint,
    phaseId: Hex,
    messageHash: Hex,
    gasPriceGwei: number
  ): Promise<Hex>;
  getSponsorBalanceWei(): Promise<bigint>;
  buildAgentWalletClient(agent: HDAccount): WalletClient;
}

export interface DayBroadcaster {
  broadcastToRoom(
    roomId: string | number,
    chainId: number,
    event: {
      type: "agent-chat";
      by: Address;
      text: string;
      persona: string;
      day: number;
      messageHash: Hex;
      commitTxHash: Hex;
    }
  ): void;
}

export type InferChatFn = typeof defaultInferChatFn;

export interface DayHandlerDeps {
  redis: Redis;
  chainOpsFor(chainId: number): DayChainOps;
  ws: DayBroadcaster;
  mnemonic: string;
  maxAgentsPerRoom?: number;
  llmWaitMs?: number;
  llmGasPriceGwei?: number;
  txGasPriceGwei?: number;
  language?: string;
  sponsorLowThresholdStt?: number;
  inferChatFn?: InferChatFn;
  /**
   * Per-agent pre-inference funding gate. Returns true if the agent EOA holds
   * enough to pay an inference deposit (topping up from the sponsor if needed),
   * false if it could not be funded (sponsor at floor). Unset → no gate.
   */
  ensureFunded?: (chainId: number, agent: Address) => Promise<boolean>;
}

export type DayOutcomeStatus =
  | CommitStatus
  | "skipped-not-active"
  | "skipped-action-idempotent"
  | "skipped-already-committed"
  | "infer-failed"
  | "AGENT_UNFUNDED";

export interface AgentDayOutcome {
  agent: Address;
  status: DayOutcomeStatus;
  msgKind?: MsgKind;
  commitTxHash?: Hex;
  llmTxHash?: Hex;
  err?: string;
}

export interface DayPromptArgs {
  self: Address;
  role: AgentRole;
  persona: string;
  alive: Address[];
  recentChat: string[];
  privateMemory?: string[];
  dayNumber: number;
  language: string;
}

function formatChatLine(raw: string): string {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.text === "string") {
      const who = typeof o.by === "string" ? o.by.toLowerCase().slice(0, 7) : "player";
      return `${who}: ${o.text}`;
    }
  } catch {
    /* not JSON — treat as a plain line */
  }
  return raw;
}

export function buildDayPrompt(args: DayPromptArgs): {
  roles: string[];
  messages: string[];
} {
  const roleLine =
    args.role === AgentRole.NONE
      ? `You don't know your role yet — play like someone hunting the mafia: react, suspect, defend. Never claim or invent a specific role.`
      : `Your hidden role is ${roleLabel(args.role)}. Play toward your role's goal, but NEVER reveal your role or any role-specific action you have performed.`;
  const system = [
    `You are ${args.persona}, a player in a game of Mafia. Stay in character.`,
    roleLine,
    `Write 1-2 sentences in ${args.language}, conversational and SPECIFIC: respond to the latest messages, name who you agree with / suspect / want to vote, and take a clear stance. No vague platitudes (e.g. "trust is thin", "stay alert", "it's quiet here"), no markdown, no role names.`,
  ].join(" ");
  const privateMemory = args.privateMemory ?? [];
  const user = [
    `Day ${args.dayNumber}. Players still alive: ${args.alive.join(", ")}.`,
    args.recentChat.length === 0
      ? `Nobody has spoken yet — open with a concrete read, question, or suggestion. Do NOT comment on the silence.`
      : `Conversation so far:\n${args.recentChat.map(formatChatLine).join("\n")}`,
    privateMemory.length === 0
      ? ``
      : `Private verified facts (let them shape your take; never quote them or reveal how you know):\n${privateMemory.join("\n")}`,
    `Now reply — react to what was just said and push the discussion forward.`,
  ]
    .filter(Boolean)
    .join("\n");
  return { roles: ["system", "user"], messages: [system, user] };
}

export class DayHandler {
  private readonly maxAgents: number;
  private readonly llmWaitMs: number;
  private readonly llmGasPriceGwei: number;
  private readonly txGasPriceGwei: number;
  private readonly language: string;
  private readonly inferChatFn: InferChatFn;
  private readonly sponsorThresholdWei: bigint;

  constructor(private readonly deps: DayHandlerDeps) {
    this.maxAgents = deps.maxAgentsPerRoom ?? 6;
    this.llmWaitMs = deps.llmWaitMs ?? 25_000;
    this.llmGasPriceGwei = deps.llmGasPriceGwei ?? 10;
    this.txGasPriceGwei = deps.txGasPriceGwei ?? 10;
    this.language = deps.language ?? "English";
    this.inferChatFn = deps.inferChatFn ?? defaultInferChatFn;
    const thresholdStt =
      deps.sponsorLowThresholdStt ?? SPONSOR_LOW_THRESHOLD_STT_DEFAULT;
    this.sponsorThresholdWei = BigInt(Math.floor(thresholdStt * 1e18));
  }

  async handle(event: DayStartedEvent): Promise<AgentDayOutcome[]> {
    const chain = this.deps.chainOpsFor(event.chainId);
    const roomIdBig = BigInt(event.roomId);
    const log = logger.child({
      mod: "agents/day",
      chainId: event.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      dayNumber: event.dayNumber,
    });

    const room = await chain.getRoom(roomIdBig).catch(() => null);
    if (!room) return [];
    if (room.phase !== PHASE_DAY) {
      log.warn({ phase: room.phase }, "[agents/day] not in DAY phase on event delivery — skipping");
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
          .then((flag) => ({ a, flag }))
          .catch(() => ({ a, flag: false }))
      )
    );
    const onChainAgentSet = isAgentResults.filter((r) => r.flag).map((r) => r.a);
    if (onChainAgentSet.length === 0) return [];

    const myAgents = matchWalletsToAgents(
      this.deps.mnemonic,
      roomIdBig,
      onChainAgentSet,
      this.maxAgents
    );
    if (myAgents.length === 0) return [];

    // Rotating round-robin: offset by dayNumber so different days start with different speakers.
    const sorted = [...myAgents].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
    );
    const len = sorted.length;
    const offset = ((event.dayNumber % len) + len) % len;
    const order = [...sorted.slice(offset), ...sorted.slice(0, offset)];

    const phaseIdHex = makePhaseId("DAY", event.dayNumber);
    const outcomes: AgentDayOutcome[] = [];

    for (const wallet of order) {
      // Pre-inference phase check (each iteration).
      const recheck = await chain.getRoom(roomIdBig).catch(() => null);
      if (!recheck || recheck.phase !== PHASE_DAY) {
        log.warn("[agents/day] phase advanced mid-round — skipping remaining agents");
        break;
      }
      const o = await this.handleOneAgent({
        chain,
        wallet,
        roomIdBig,
        event,
        phaseIdHex,
        aliveAddrs,
      }).catch((err): AgentDayOutcome => {
        log.error({ err, agent: wallet.address }, "[agents/day] handleOneAgent threw");
        return {
          agent: wallet.address,
          status: "COMMIT_FAILED",
          err: String(err?.message ?? err),
        };
      });
      outcomes.push(o);
    }

    log.info(
      { outcomes: outcomes.map((o) => ({ a: o.agent, s: o.status, k: o.msgKind })) },
      "[agents/day] done"
    );
    return outcomes;
  }

  /**
   * Make ONE managed agent take its DAY turn: read context (incl. human chat),
   * infer, commit, broadcast. Idempotent via the same action-key + on-chain
   * dedup as the burst path. Returns handled:false if the address is not one of
   * our wallets or the room is not in DAY.
   *
   * Note: handled:true means "this was our agent's turn and we attempted it" —
   * NOT that a message was committed. Inference/commit failures are logged and
   * persisted as traces inside handleOneAgent; the caller only needs to know the
   * turn was claimed.
   */
  async speakAgentTurn(args: {
    chainId: number;
    roomId: string;
    dayNumber: number;
    agentAddr: Address;
  }): Promise<{ handled: boolean }> {
    // Per-chain DAY-chat gate: skip chains with no usable LLM chat store
    // (e.g. mainnet on a dual-chain deployment) instead of crashing/erroring.
    if (!hasUsableChatStore(args.chainId)) return { handled: false };

    const chain = this.deps.chainOpsFor(args.chainId);
    const roomIdBig = BigInt(args.roomId);

    const room = await chain.getRoom(roomIdBig).catch(() => null);
    if (!room || room.phase !== PHASE_DAY) return { handled: false };

    const ours = matchWalletsToAgents(
      this.deps.mnemonic,
      roomIdBig,
      [args.agentAddr],
      this.maxAgents
    );
    if (ours.length === 0) return { handled: false };
    const wallet = ours[0];

    const players = await chain.getPlayers(roomIdBig);
    const aliveAddrs = players
      .filter((p) => (p.flags & FLAG_ACTIVE) !== 0)
      .map((p) => p.wallet);

    const phaseIdHex = makePhaseId("DAY", args.dayNumber);
    const event: DayStartedEvent = {
      type: "DAY_STARTED",
      chainId: chain.chainId,
      roomId: args.roomId,
      // Match the canonical chain-event phaseId (events.ts: `D${n}-DAY`) so the
      // redis action/trace/skip/committed keys line up with the real DayStarted
      // path and the post-game audit/reveal surface.
      phaseId: `D${args.dayNumber}-DAY`,
      dayNumber: args.dayNumber,
      blockNumber: 0,
      txHash: ZERO_BYTES32,
      logIndex: 0,
    };

    await this.handleOneAgent({ chain, wallet, roomIdBig, event, phaseIdHex, aliveAddrs }).catch(
      () => undefined
    );
    return { handled: true };
  }

  private async handleOneAgent(args: {
    chain: DayChainOps;
    wallet: AgentWallet;
    roomIdBig: bigint;
    event: DayStartedEvent;
    phaseIdHex: Hex;
    aliveAddrs: Address[];
  }): Promise<AgentDayOutcome> {
    const { chain, wallet, roomIdBig, event, phaseIdHex, aliveAddrs } = args;
    const log = logger.child({
      mod: "agents/day",
      chainId: chain.chainId,
      roomId: event.roomId,
      phaseId: event.phaseId,
      agent: wallet.address,
    });

    // 1. Action-key idempotency.
    const actionKey = agentActionProcessedKey(
      chain.chainId,
      event.roomId,
      event.phaseId,
      wallet.address,
      "day-chat"
    );
    const claimed = await this.deps.redis.set(
      actionKey,
      JSON.stringify({ startedAt: Date.now() }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS,
      "NX"
    );
    if (claimed !== "OK") {
      return { agent: wallet.address, status: "skipped-action-idempotent" };
    }

    // 2. On-chain dedup pre-check (F1 source of truth).
    const existing = await chain.getAgentMessageHash(
      roomIdBig,
      phaseIdHex,
      wallet.address
    );
    if (existing !== ZERO_BYTES32) {
      await this.deps.redis.del(actionKey).catch(() => undefined);
      return { agent: wallet.address, status: "skipped-already-committed" };
    }

    // 3. Sponsor balance guard.
    const sponsorWei = await chain.getSponsorBalanceWei().catch(() => 0n);
    if (sponsorWei < this.sponsorThresholdWei) {
      await this.deps.redis.set(
        agentSkipReasonKey(chain.chainId, event.roomId, event.phaseId, wallet.address),
        "sponsor-low-no-inference",
        "EX",
        DAY_CHAT_TTL_SECONDS
      );
      log.warn({ sponsorWei: sponsorWei.toString() }, "[agents/day] sponsor low — skipping agent");
      return { agent: wallet.address, status: "SPONSOR_LOW" };
    }

    // 3b. Per-agent wallet funding. fill-room seeds a fixed reserve; over a long
    // game an agent can deplete below one inference deposit (~0.24 STT) and then
    // createRequest reverts (agent goes silent). Top up from the sponsor first.
    if (this.deps.ensureFunded) {
      const funded = await this.deps
        .ensureFunded(chain.chainId, wallet.address)
        .catch((err) => {
          log.warn(
            { err: String(err?.message ?? err) },
            "[agents/day] ensureFunded threw — proceeding best-effort"
          );
          return true;
        });
      if (!funded) {
        await this.deps.redis.set(
          agentSkipReasonKey(chain.chainId, event.roomId, event.phaseId, wallet.address),
          "agent-unfunded-no-inference",
          "EX",
          DAY_CHAT_TTL_SECONDS
        );
        log.warn("[agents/day] agent wallet unfunded and sponsor at floor — skipping");
        return { agent: wallet.address, status: "AGENT_UNFUNDED" };
      }
    }

    // 4. Load context.
    const role = await getAgentRole(
      this.deps.redis,
      chain.chainId,
      event.roomId,
      wallet.address
    );
    const persona = await getOrPinPersona(
      this.deps.redis,
      chain.chainId,
      event.roomId,
      wallet.address
    );
    const recentChat = await this.deps.redis.lrange(
      agentChatPromptKey(chain.chainId, event.roomId),
      -20,
      -1
    );
    const privateMemory = await loadMemoryPromptLines(
      this.deps.redis,
      chain.chainId,
      event.roomId,
      wallet.address
    ).catch(() => []);

    // 5. Persist PENDING_INFERENCE.
    await this.persistTrace(chain.chainId, event, wallet.address, {
      commitStatus: "PENDING_INFERENCE",
      role,
      persona,
      dayNumber: event.dayNumber,
    });

    // 6. Build prompt + call inferChat.
    const { roles, messages } = buildDayPrompt({
      self: wallet.address,
      role,
      persona,
      alive: aliveAddrs,
      recentChat,
      privateMemory,
      dayNumber: event.dayNumber,
      language: this.language,
    });
    const walletClient = chain.buildAgentWalletClient(wallet.account);

    let infer: InferChatResult;
    try {
      infer = await this.inferChatFn(
        { roles, messages, chainOfThought: false },
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
        "[agents/day] inferChat threw"
      );
      // Action key STAYS HELD per F-new (DAY silence is benign, prevent retry storm).
      await this.persistTrace(chain.chainId, event, wallet.address, {
        commitStatus: "INFER_TIMEOUT",
        err: String(err?.message ?? err),
      });
      return {
        agent: wallet.address,
        status: "INFER_TIMEOUT",
        err: String(err?.message ?? err),
      };
    }

    if (infer.result === null) {
      // Timeout or non-success status — action key STAYS HELD.
      await this.persistTrace(chain.chainId, event, wallet.address, {
        commitStatus: "INFER_TIMEOUT",
        llmTxHash: infer.txHash,
        somniaRequestId: infer.requestId.toString(),
      });
      return {
        agent: wallet.address,
        status: "INFER_TIMEOUT",
        llmTxHash: infer.txHash,
      };
    }

    const rawText = infer.result.response ?? "";

    // 7. Scrub.
    const scrub: ScrubResult = scrubText(rawText);
    const msgKind: MsgKind = scrub.outcome === "ALLOWED" ? "MSG" : "SKIP_SCRUBBED";
    const sanitized = scrub.outcome === "ALLOWED" ? scrub.sanitized : null;

    // 8. Compute hashes (BEFORE phase recheck — F-new-round4 order fix).
    const salt = randomSalt();
    const rawResponseHash = keccak256(toHex(rawText));
    const promptHash = canonicalPromptHash(roles, messages);
    const sanitizedTextHash =
      msgKind === "MSG" && sanitized ? messageTextHash(sanitized) : ZERO_BYTES32;
    const messageHash = computeMessageHash({
      chainId: BigInt(chain.chainId),
      diamond: chain.diamond,
      roomId: roomIdBig,
      phaseId: phaseIdHex,
      agent: wallet.address,
      salt,
      somniaRequestId: infer.requestId,
      promptHash,
      rawResponseHash,
      sanitizedTextHash,
      scrubVersion: SCRUB_VERSION,
      scrubAllowed: scrub.outcome === "ALLOWED",
      msgKind: msgKind === "MSG" ? MSG_KIND_REGULAR : MSG_KIND_SKIP_SCRUBBED,
    });

    // 9. F3 second phase recheck.
    const recheck = await chain.getRoom(roomIdBig).catch(() => null);
    if (!recheck || recheck.phase !== PHASE_DAY) {
      await this.persistTrace(chain.chainId, event, wallet.address, {
        commitStatus: "PHASE_ADVANCED",
        msgKind,
        scrubOutcome: scrub.outcome,
        somniaRequestId: infer.requestId.toString(),
        llmTxHash: infer.txHash,
        promptHash,
        rawResponseHash,
        sanitizedTextHash,
        salt,
        messageHash,
      });
      await this.deps.redis.del(actionKey).catch(() => undefined);
      return {
        agent: wallet.address,
        status: "PHASE_ADVANCED",
        msgKind,
        llmTxHash: infer.txHash,
      };
    }

    // 10. Persist PENDING_COMMIT + send tx.
    await this.persistTrace(chain.chainId, event, wallet.address, {
      commitStatus: "PENDING_COMMIT",
      msgKind,
      scrubOutcome: scrub.outcome,
      somniaRequestId: infer.requestId.toString(),
      llmTxHash: infer.txHash,
      promptHash,
      rawResponseHash,
      sanitizedTextHash,
      salt,
      messageHash,
      sanitizedText: sanitized,
    });

    let commitTxHash: Hex | undefined;
    let recoveryStatus: "self-retry" | "conflict" | "failed" | null = null;
    try {
      commitTxHash = await chain.sendCommitMessageV2(
        wallet.account,
        roomIdBig,
        phaseIdHex,
        messageHash,
        this.txGasPriceGwei
      );
    } catch (err: any) {
      // F-new-round4-1: reason-agnostic recovery via getAgentMessageHash.
      const stored = await chain
        .getAgentMessageHash(roomIdBig, phaseIdHex, wallet.address)
        .catch(() => ZERO_BYTES32);
      if (stored === messageHash) {
        recoveryStatus = "self-retry";
        log.info("[agents/day] commit revert + stored == ours → idempotent self-retry");
      } else if (stored !== ZERO_BYTES32) {
        recoveryStatus = "conflict";
        log.error(
          { stored, ours: messageHash, err: String(err?.message ?? err) },
          "[agents/day] COMMIT_CONFLICT — chain has different hash"
        );
        await this.persistTrace(chain.chainId, event, wallet.address, {
          commitStatus: "COMMIT_CONFLICT",
          storedHash: stored,
          localHash: messageHash,
          err: String(err?.message ?? err),
        });
        return {
          agent: wallet.address,
          status: "COMMIT_CONFLICT",
          msgKind,
          err: String(err?.message ?? err),
        };
      } else {
        recoveryStatus = "failed";
        log.error(
          { err: String(err?.message ?? err) },
          "[agents/day] commitAgentMessageV2 reverted with no stored hash"
        );
        await this.persistTrace(chain.chainId, event, wallet.address, {
          commitStatus: "COMMIT_FAILED",
          err: String(err?.message ?? err),
        });
        return {
          agent: wallet.address,
          status: "COMMIT_FAILED",
          msgKind,
          err: String(err?.message ?? err),
        };
      }
    }

    // 11. Success-path side effects.
    await this.persistTrace(chain.chainId, event, wallet.address, {
      commitStatus: "COMMITTED",
      commitTxHash: commitTxHash ?? null,
    });
    await this.deps.redis.set(
      agentMessageCommittedKey(chain.chainId, event.roomId, event.phaseId, wallet.address),
      "1",
      "EX",
      DAY_CHAT_TTL_SECONDS
    );

    if (msgKind === "MSG" && sanitized) {
      const entry = JSON.stringify({
        by: wallet.address.toLowerCase(),
        text: sanitized,
        day: event.dayNumber,
        ts: Date.now(),
      });
      await this.deps.redis.rpush(
        agentChatPromptKey(chain.chainId, event.roomId),
        entry
      );
      await this.deps.redis.ltrim(
        agentChatPromptKey(chain.chainId, event.roomId),
        -20,
        -1
      );
      await this.deps.redis.rpush(agentChatLogKey(chain.chainId, event.roomId), entry);
      await this.deps.redis.expire(
        agentChatLogKey(chain.chainId, event.roomId),
        DAY_CHAT_TTL_SECONDS
      );

      // F-new-2: NO somniaRequestId / promptHash / rawResponseHash in WS payload.
      this.deps.ws.broadcastToRoom(event.roomId, chain.chainId, {
        type: "agent-chat",
        by: wallet.address,
        text: sanitized,
        persona,
        day: event.dayNumber,
        messageHash,
        commitTxHash: (commitTxHash ?? ZERO_BYTES32) as Hex,
      });
    }

    return {
      agent: wallet.address,
      status: "COMMITTED",
      msgKind,
      commitTxHash,
      llmTxHash: infer.txHash,
    };
  }

  private async persistTrace(
    chainId: number,
    event: DayStartedEvent,
    agent: Address,
    patch: Record<string, unknown>
  ): Promise<void> {
    const key = agentTraceKey(chainId, event.roomId, event.phaseId, agent);
    const prev = await this.deps.redis.get(key);
    const base = prev ? JSON.parse(prev) : {};
    await this.deps.redis.set(
      key,
      JSON.stringify({ ...base, ...patch, updatedAt: Date.now() }),
      "EX",
      DAY_CHAT_TTL_SECONDS
    );
  }
}

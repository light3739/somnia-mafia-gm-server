/**
 * agents/index.ts — Entry point for the autonomous-agent subsystem.
 *
 * 4a builds the agent event bus: it detects phase transitions and prepares
 * safe, idempotent dispatching. It makes no decisions, signs no transactions,
 * and runs no LLM inference. Phase-specific handlers are wired in later tasks
 * (4b VOTING, 4d DAY, 4f NIGHT, 4c GameEnded reveal).
 *
 * Boot is opt-in via AGENTS_ENABLED=true so production gm-server deployments
 * are unaffected until the subsystem is feature-complete.
 */
import { parseEther, type Address, type Hex } from "viem";
import { getRedis } from "../redis.js";
import { getChainConfig } from "../chain.js";
import { logger } from "../utils/logger.js";
import { AgentDispatcher } from "./dispatcher.js";
import { AgentEventListener } from "./listener.js";
import { VotingHandler } from "./voting.js";
import { NightHandler } from "./night.js";
import { DayHandler, type DayBroadcaster } from "./day.js";
import { PreGameHandler } from "./pregame.js";
import { makeVoteChainOps, makePreGameChainOps } from "./chain-ops.js";
import { loadOrGenerateMnemonic } from "./wallets.js";
import { ensureAgentFunded, type FundingOps } from "./agent-funding.js";
import { getSponsorBalance, topUp } from "./sponsor.js";
import { PhaseTimeoutDriver } from "./phase-timeout.js";
import { wsManager } from "../ws/wsManager.js";
import type { GMStore } from "../stores/index.js";
import { recordAgentNightAction } from "./night-action-bridge.js";
import { registerOnResolved } from "../services/roleResolution.js";
import { ServerStore } from "../services/serverStore.js";
import { turnController } from "./turnController.js";
import {
  getCurrentSpeaker,
  advanceAndBroadcast,
  getAliveShuffled,
} from "../services/discussionTurns.js";
import { hasUsableChatStore } from "./llm-chat-call.js";
import { resolveNickname } from "../services/logListener.js";
import { HeadlessDayDriver } from "./headless-day.js";
import { agentHeadlessDayKey } from "./redis-keys.js";

let activeListener: AgentEventListener | null = null;

function isEnabled(): boolean {
  return (process.env.AGENTS_ENABLED ?? "").toLowerCase() === "true";
}

function resolveChainIds(): number[] {
  const raw = process.env.AGENTS_CHAIN_IDS;
  if (raw) {
    return raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  // Default: testnet only. Master plan locks mainnet rollout to demo time.
  return [50312];
}

/**
 * 4d DAY chat boot validation. Fails fast on misconfig so a deployment with
 * AGENTS_DAY_ENABLED=true cannot silently skip every commit due to a missing
 * store address.
 */
function assertDayConfig(chainIds: number[]): void {
  const enabled = (process.env.AGENTS_DAY_ENABLED ?? "").toLowerCase() === "true";
  if (!enabled) return;
  // Per-chain: warn (do NOT crash) for chains without a usable LLM chat store.
  // A dual-chain deployment (e.g. testnet+mainnet) where only some chains have a
  // store must still boot; agents skip DAY chat on the storeless chains.
  for (const cid of chainIds) {
    if (!hasUsableChatStore(cid)) {
      logger.warn(
        { chainId: cid },
        `[agents] DAY chat unavailable on chain ${cid} (no LLM chat store configured — set LLM_CHAT_STORE_${cid}); agents will skip DAY chat there`
      );
    }
  }
  const scrubber = (process.env.SCRUBBER_MODE ?? "strict").toLowerCase();
  if (scrubber === "disabled" && process.env.NODE_ENV !== "local") {
    throw new Error(
      `[agents] SCRUBBER_MODE=disabled is only allowed when NODE_ENV=local (got NODE_ENV=${process.env.NODE_ENV})`
    );
  }
}

export async function startAgentSubsystem(store?: GMStore): Promise<void> {
  if (!isEnabled()) {
    logger.info(
      "[agents] AGENTS_ENABLED!=true — agent subsystem disabled (set AGENTS_ENABLED=true to activate)"
    );
    return;
  }

  const redis = getRedis();
  if (!redis) {
    logger.error("[agents] cannot start: Redis is not connected");
    return;
  }

  const chainIds = resolveChainIds();
  const diamondByChain = new Map<number, Hex>();
  for (const chainId of chainIds) {
    try {
      const { diamond } = getChainConfig(chainId);
      diamondByChain.set(chainId, diamond);
    } catch (err) {
      logger.warn(
        { err, chainId },
        `[agents] chain ${chainId} not configured, skipping`
      );
    }
  }

  if (diamondByChain.size === 0) {
    logger.warn("[agents] no chains configured, subsystem inactive");
    return;
  }

  // 4d boot validation — fail fast on misconfig.
  assertDayConfig([...diamondByChain.keys()]);

  // Build per-chain VoteChainOps once (closures inside cache the viem clients).
  // VotingHandler is stateless across chains — chainOpsFor dispatches.
  const chainOpsCache = new Map<number, ReturnType<typeof makeVoteChainOps>>();
  for (const chainId of diamondByChain.keys()) {
    chainOpsCache.set(chainId, makeVoteChainOps(chainId));
  }

  const mnemonic = loadOrGenerateMnemonic();
  const language = process.env.AGENTS_LANGUAGE ?? "English";
  const chainOpsFor = (chainId: number) => {
    const ops = chainOpsCache.get(chainId);
    if (!ops) throw new Error(`[agents] no chainOps for chainId ${chainId}`);
    return ops;
  };

  // Per-agent auto-topup: before a phase handler pays an inference deposit it
  // ensures the agent EOA can afford it, refilling from the sponsor (never below
  // the sponsor floor). fill-room seeds the initial reserve; this backstops
  // depletion over a long game so agents never go silent mid-game. See
  // agents/agent-funding.ts.
  const txGasPriceGwei = Number(process.env.TX_GAS_PRICE_GWEI ?? "10");
  const agentMinWei = BigInt(
    process.env.AGENT_MIN_BALANCE_WEI ?? parseEther("0.5").toString()
  );
  const agentTopUpToWei = BigInt(
    process.env.AGENT_GAS_RESERVE_WEI ?? parseEther("2.5").toString()
  );
  const sponsorFloorWei = BigInt(
    Math.floor(Number(process.env.SPONSOR_LOW_THRESHOLD_STT ?? "1.5") * 1e18)
  );
  const makeFundingOps = (chainId: number): FundingOps => {
    const { public: publicClient } = getChainConfig(chainId);
    return {
      getBalanceWei: (addr) => publicClient.getBalance({ address: addr }),
      getSponsorBalanceWei: () => getSponsorBalance(chainId),
      topUp: (to, valueWei) =>
        topUp(chainId, to, valueWei, { gasPriceGwei: txGasPriceGwei }),
    };
  };
  const ensureFunded = async (
    chainId: number,
    agent: Address
  ): Promise<boolean> => {
    const res = await ensureAgentFunded(makeFundingOps(chainId), agent, {
      minWei: agentMinWei,
      topUpToWei: agentTopUpToWei,
      sponsorFloorWei,
    });
    if (res.toppedUp) {
      logger.info(
        { chainId, agent, txHash: res.txHash },
        "[agents] auto-topped-up agent EOA before inference"
      );
    } else if (!res.funded) {
      logger.warn(
        { chainId, agent, balanceWei: res.balanceWei.toString() },
        "[agents] agent EOA unfunded and sponsor at floor — inference skipped"
      );
    }
    return res.funded;
  };

  const votingHandler = new VotingHandler({
    redis,
    chainOpsFor,
    mnemonic,
    language,
    ensureFunded,
  });

  const nightHandler = new NightHandler({
    redis,
    chainOpsFor,
    mnemonic,
    language,
    recordNightAction: store
      ? (record) => recordAgentNightAction(record, { store, redis })
      : undefined,
  });

  // 4j pre-game — its chain surface differs from VoteChainOps, so a separate
  // cache. Drives all-agent rooms through SHUFFLING+REVEAL to DAY. Always wired
  // when the subsystem is on: in a human/mixed room our agents aren't the
  // shuffler so it no-ops harmlessly.
  const preGameOpsCache = new Map<number, ReturnType<typeof makePreGameChainOps>>();
  for (const chainId of diamondByChain.keys()) {
    preGameOpsCache.set(chainId, makePreGameChainOps(chainId));
  }
  const preGameHandler = new PreGameHandler({
    redis,
    chainOpsFor: (chainId: number) => {
      const ops = preGameOpsCache.get(chainId);
      if (!ops) throw new Error(`[agents] no preGameChainOps for chainId ${chainId}`);
      return ops;
    },
    mnemonic,
    txGasPriceGwei: Number(process.env.TX_GAS_PRICE_GWEI ?? "10"),
    shareKeysOnChain:
      (process.env.AGENTS_SHARE_KEYS_ONCHAIN ?? "").toLowerCase() === "true",
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

  // 4d DAY chat — opt-in via AGENTS_DAY_ENABLED. Skipped (no listener wire)
  // when disabled so a misconfigured deployment cannot accidentally chat-spam.
  const dayEnabled =
    (process.env.AGENTS_DAY_ENABLED ?? "").toLowerCase() === "true";
  let dayHandler: DayHandler | undefined;
  if (dayEnabled) {
    const broadcaster: DayBroadcaster = {
      broadcastToRoom(roomId, chainId, ev) {
        const { type, ...data } = ev;
        wsManager.broadcastToRoom(roomId, chainId, { type, data });
        // The frontend has no 'agent-chat' WS handler and /logs reads the
        // game-log store — so also persist the message there to make agent chat
        // visible in the in-game log panel the UI already polls (/logs/:roomId).
        const short = `${ev.by.slice(0, 6)}…${ev.by.slice(-4)}`;
        void ServerStore.addGameLog(
          String(roomId),
          {
            id: `agentchat-${ev.messageHash}`,
            message: `🤖 ${ev.persona} (${short}): ${ev.text}`,
            type: "info",
            timestamp: Date.now(),
          },
          chainId
        ).catch((err) =>
          logger.warn(
            { err, roomId: String(roomId) },
            "[agents] addGameLog(agent-chat) failed"
          )
        );
      },
    };
    dayHandler = new DayHandler({
      redis,
      chainOpsFor,
      ws: broadcaster,
      mnemonic,
      language: process.env.AGENTS_DAY_LANGUAGE ?? language,
      llmWaitMs: Number(process.env.LLM_CHAT_WAIT_MS ?? "60000"),
      llmGasPriceGwei: Number(process.env.LLM_CHAT_GAS_PRICE_GWEI ?? "10"),
      txGasPriceGwei: Number(process.env.TX_GAS_PRICE_GWEI ?? "10"),
      sponsorLowThresholdStt: Number(process.env.SPONSOR_LOW_THRESHOLD_STT ?? "1.5"),
      resolveName: resolveNickname,
      ensureFunded,
    });
    const dh = dayHandler;
    turnController.configure({
      redis,
      getCurrentSpeaker,
      advanceAndBroadcast,
      isAgent: (chainId, roomId, addr) =>
        chainOpsFor(chainId).isAgent(BigInt(roomId), addr as `0x${string}`),
      speakOneAgent: (chainId, roomId, dayNumber, agentAddr) =>
        dh.speakAgentTurn({ chainId, roomId, dayNumber, agentAddr: agentAddr as `0x${string}` }),
    });
  }

  // Agent-driven phase timeout: an alive agent advances DAY/VOTING at the
  // deadline when no alive human's browser did (last human died / all-agent).
  // Reuses the funded agent EOAs; defers to humans via a larger buffer.
  const phaseKickEnabled =
    (process.env.AGENTS_PHASE_KICK_ENABLED ?? "true").toLowerCase() !== "false";
  const phaseTimeoutDriver = phaseKickEnabled
    ? new PhaseTimeoutDriver({
        chainOpsFor,
        mnemonic,
        gasPriceGwei: txGasPriceGwei,
        bufferSec: Number(process.env.AGENTS_PHASE_KICK_BUFFER_SEC ?? "12"),
      })
    : undefined;

  // Headless DAY discussion: when no alive human is left to start/advance the
  // rotation from a browser, an agent does it (start discussion → drive turns →
  // start voting early). Only when DAY chat is on (else turnController is
  // unconfigured and driving turns is a no-op). Mixed games are untouched.
  const headlessDayDriver = dayEnabled
    ? new HeadlessDayDriver({
        chainOpsFor,
        mnemonic,
        gasPriceGwei: txGasPriceGwei,
        dayEnabled: true,
        // Server-side equivalent of a player's browser POSTing /discussion `start`.
        async startDiscussion(chainId, roomId, dayCount) {
          const existing = await ServerStore.getDiscussionState(roomId, dayCount, chainId);
          // Idempotent: don't clobber a discussion already active/finished.
          if (existing && (existing.finished || existing.phase === "speaking")) return;
          const alive = await getAliveShuffled(chainId, roomId);
          await ServerStore.setDiscussionState(
            roomId,
            dayCount,
            {
              currentSpeakerIndex: 0,
              speakerStartTime: Date.now(),
              speakerDuration: 60,
              finished: false,
              phase: "speaking",
            },
            chainId
          );
          const first = alive[0];
          wsManager.broadcastToRoom(roomId, chainId, {
            type: "discussion-update",
            data: {
              currentSpeakerAddress: first?.wallet || null,
              currentSpeakerIndex: 0,
              phase: "speaking",
              finished: false,
            },
          });
        },
        driveTurns: (chainId, roomId, dayCount) =>
          turnController.onSpeakerChanged(chainId, roomId, dayCount),
        // Once-per-day claim (15min TTL > any single DAY) so re-delivered
        // DAY_STARTED events don't double-drive.
        claimOnce: async (chainId, roomId, dayCount) =>
          (await redis.set(
            agentHeadlessDayKey(chainId, roomId, dayCount),
            "1",
            "EX",
            15 * 60,
            "NX"
          )) === "OK",
      })
    : undefined;

  const dispatcher = new AgentDispatcher({
    redis,
    diamondByChain,
    votingHandler,
    nightHandler,
    preGameHandler,
    phaseTimeoutDriver,
    headlessDayDriver,
  });
  const listener = new AgentEventListener(dispatcher);
  listener.start([...diamondByChain.keys()]);
  activeListener = listener;

  logger.info(
    {
      chainIds: [...diamondByChain.keys()],
      diamonds: [...diamondByChain.entries()].map(([cid, d]) => `${cid}=${d}`),
      handlersWired: [
        "GAME_STARTED",
        "DECK_REVEALED",
        "VOTING_STARTED",
        "NIGHT_STARTED",
        // DAY_STARTED always starts the phase-timeout watch; DAY chat is driven
        // per-turn via discussionRoutes→turnController (only when dayEnabled).
        "DAY_STARTED",
      ],
    },
    "[agents] subsystem started"
  );
}

export function stopAgentSubsystem(): void {
  activeListener?.stop();
  activeListener = null;
}

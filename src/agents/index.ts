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
import type { Hex } from "viem";
import { getRedis } from "../redis.js";
import { getChainConfig } from "../chain.js";
import { logger } from "../utils/logger.js";
import { AgentDispatcher } from "./dispatcher.js";
import { AgentEventListener } from "./listener.js";

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

export async function startAgentSubsystem(): Promise<void> {
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

  const dispatcher = new AgentDispatcher({ redis, diamondByChain });
  const listener = new AgentEventListener(dispatcher);
  listener.start([...diamondByChain.keys()]);
  activeListener = listener;

  logger.info(
    {
      chainIds: [...diamondByChain.keys()],
      diamonds: [...diamondByChain.entries()].map(([cid, d]) => `${cid}=${d}`),
    },
    "[agents] subsystem started"
  );
}

export function stopAgentSubsystem(): void {
  activeListener?.stop();
  activeListener = null;
}

/**
 * agents/listener.ts — Subscribes to the four phase-transition events on the
 * Diamond and forwards normalised AgentEvents to the dispatcher.
 *
 * Reuses gm-server's existing chain config (WS+HTTP fallback, reconnect,
 * keepalive) — no duplicated WS connection logic.
 *
 * Resolves dayNumber for VOTING_STARTED / NIGHT_STARTED / GAME_ENDED by
 * reading `getRoom(roomId)` once per event. (DayStarted carries it natively.)
 *
 * Backfill from lastBlockKey is NOT implemented in 4a — the listener starts
 * from the latest block. The hook is left here as a TODO so future work
 * can add it without changing the call site.
 */
import type { Hex } from "viem";
import { getChainConfig, DIAMOND_ABI, getRoom } from "../chain.js";
import { logger } from "../utils/logger.js";
import { normaliseLog } from "./events.js";
import type { AgentDispatcher } from "./dispatcher.js";

const PHASE_TRANSITION_EVENTS = [
  "GameStarted", // 4j pre-game kickoff (→ SHUFFLING)
  "DeckRevealed", // 4j shuffle advance / REVEAL trigger
  "DayStarted",
  "VotingStarted",
  "NightStarted",
  "GameEnded",
] as const;

type ListenerHandle = {
  chainId: number;
  unwatch: () => void;
};

export class AgentEventListener {
  private active: ListenerHandle[] = [];

  constructor(private readonly dispatcher: AgentDispatcher) {}

  start(chainIds: number[]): void {
    for (const chainId of chainIds) {
      try {
        this.startOne(chainId);
      } catch (err) {
        logger.error(
          { err, chainId },
          `[agents] failed to start listener for chain ${chainId}`
        );
      }
    }
  }

  private startOne(chainId: number): void {
    const { public: client, diamond } = getChainConfig(chainId);
    logger.info(
      `[agents] subscribing to phase events on chain ${chainId} @ ${diamond}`
    );

    // TODO 4a-followup: read lastBlockKey from Redis and backfill from
    // (lastBlock - confirmations) before starting watchContractEvent. For now
    // we start from latest — acceptable for testnet MVP, lossy on restart.

    const unwatch = client.watchContractEvent({
      address: diamond,
      abi: DIAMOND_ABI,
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          await this.handleRawLog(chainId, log).catch((err) =>
            logger.error({ err, log }, "[agents] handleRawLog failed")
          );
        }
      },
    });

    this.active.push({ chainId, unwatch });
  }

  private async handleRawLog(chainId: number, log: any): Promise<void> {
    const eventName = log.eventName as string | undefined;
    if (!eventName || !PHASE_TRANSITION_EVENTS.includes(eventName as any)) {
      return;
    }

    // Resolve dayNumber only for the two events whose ABI lacks it AND whose
    // normaliser needs it (VotingStarted / NightStarted). DayStarted reads it
    // straight from its own args; GameStarted / DeckRevealed / GameEnded don't
    // use it — so we skip the getRoom round-trip (DeckRevealed fires often).
    let dayNumber: number | undefined;
    if (eventName === "VotingStarted" || eventName === "NightStarted") {
      const roomId = (log.args?.roomId as bigint | undefined) ?? null;
      if (roomId != null) {
        try {
          const room = await getRoom(roomId, chainId);
          dayNumber = Number(room.dayCount);
        } catch (err) {
          logger.warn(
            { err, chainId, roomId: roomId.toString() },
            "[agents] getRoom failed during dayNumber resolution; defaulting to 0"
          );
          dayNumber = 0;
        }
      }
    }

    const event = normaliseLog(
      {
        eventName: log.eventName,
        args: log.args,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      },
      { chainId, dayNumber }
    );
    if (!event) return;

    await this.dispatcher.dispatch(event);
  }

  stop(): void {
    for (const h of this.active) {
      try {
        h.unwatch();
      } catch {
        // best-effort
      }
    }
    this.active = [];
  }
}

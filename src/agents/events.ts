/**
 * agents/events.ts — Normalised AgentEvent shape and raw-log normaliser.
 *
 * The agent subsystem only cares about a small subset of Diamond events that
 * mark a phase transition. Each event becomes an `AgentEvent` carrying enough
 * coordinates (chainId, txHash, logIndex, blockNumber) to compute a stable
 * idempotency key, plus a semantic `phaseId` like "D3-VOTING" so downstream
 * agent handlers can address one slot per game phase.
 *
 * normaliseLog() is pure — it does NOT touch the chain. dayNumber for VOTING /
 * NIGHT / GAME_ENDED events that don't carry it in their ABI is resolved in
 * the listener (via getRoom) before normalisation.
 */
import type { Hex } from "viem";

export type AgentEventBase = {
  chainId: number;
  roomId: string;
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
};

export type AgentEvent =
  | (AgentEventBase & {
      type: "GAME_STARTED";
      phaseId: string;
    })
  | (AgentEventBase & {
      type: "DECK_REVEALED";
      phaseId: string;
    })
  | (AgentEventBase & {
      type: "DAY_STARTED";
      phaseId: string;
      dayNumber: number;
    })
  | (AgentEventBase & {
      type: "VOTING_STARTED";
      phaseId: string;
      dayNumber: number;
    })
  | (AgentEventBase & {
      type: "NIGHT_STARTED";
      phaseId: string;
      dayNumber: number;
    })
  | (AgentEventBase & {
      type: "GAME_ENDED";
      phaseId: string;
      winCondition: string;
    });

export type RawLog = {
  eventName?: string;
  args?: Record<string, unknown>;
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
  logIndex?: number | null;
};

export type NormaliseContext = {
  chainId: number;
  /** dayNumber resolved by the caller for events whose ABI does not carry it. */
  dayNumber?: number;
};

/**
 * Convert a raw Diamond log into an AgentEvent — or `null` if the log is not
 * one of the 4 phase-transition events we care about.
 *
 * Caller is responsible for resolving dayNumber for VOTING_STARTED /
 * NIGHT_STARTED / GAME_ENDED (their ABI doesn't carry it) and passing it in
 * via `ctx.dayNumber`.
 */
export function normaliseLog(
  log: RawLog,
  ctx: NormaliseContext
): AgentEvent | null {
  if (!log.eventName || !log.args) return null;
  const roomId = (log.args.roomId as bigint | undefined)?.toString();
  if (!roomId) return null;
  const blockNumber = Number(log.blockNumber ?? 0);
  const txHash = log.transactionHash as Hex | null;
  const logIndex = log.logIndex ?? 0;
  if (!txHash) return null;

  const base: AgentEventBase = {
    chainId: ctx.chainId,
    roomId,
    blockNumber,
    txHash,
    logIndex,
  };

  switch (log.eventName) {
    // 4j pre-game. Both carry only room coordinates — the heavy `deck` arg on
    // DeckRevealed is deliberately dropped (PreGameHandler re-reads getDeck).
    case "GameStarted":
      return { ...base, type: "GAME_STARTED", phaseId: "SHUFFLING" };
    case "DeckRevealed":
      return { ...base, type: "DECK_REVEALED", phaseId: "SHUFFLING" };
    case "DayStarted": {
      const dayNumber = Number(log.args.dayNumber as bigint);
      return {
        ...base,
        type: "DAY_STARTED",
        dayNumber,
        phaseId: `D${dayNumber}-DAY`,
      };
    }
    case "VotingStarted": {
      const dayNumber = ctx.dayNumber ?? 0;
      return {
        ...base,
        type: "VOTING_STARTED",
        dayNumber,
        phaseId: `D${dayNumber}-VOTING`,
      };
    }
    case "NightStarted": {
      const dayNumber = ctx.dayNumber ?? 0;
      return {
        ...base,
        type: "NIGHT_STARTED",
        dayNumber,
        phaseId: `D${dayNumber}-NIGHT`,
      };
    }
    case "GameEnded": {
      const winCondition = String(log.args.winCondition ?? "UNKNOWN");
      return {
        ...base,
        type: "GAME_ENDED",
        winCondition,
        phaseId: "ENDED",
      };
    }
    default:
      return null;
  }
}

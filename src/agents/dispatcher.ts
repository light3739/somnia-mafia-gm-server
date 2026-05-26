/**
 * agents/dispatcher.ts — Event-level dispatcher.
 *
 * Single entry point for normalised AgentEvents. Responsibilities (4a):
 *   - event-level idempotency (skip if already processed)
 *   - advance the per-chain last-block cursor
 *   - log "would dispatch" for visibility
 *
 * NO transactions. NO LLM inference. NO agent action selection.
 *
 * Phase-specific handlers (vote, day chat, night action) are wired in later
 * tasks (4b/4d/4f) — they will register here and the dispatcher will route by
 * `event.type`. For 4a, route-by-type is a stub.
 */
import type { Redis } from "ioredis";
import type { Hex } from "viem";
import { Mutex } from "async-mutex";
import { logger } from "../utils/logger.js";
import type { AgentEvent } from "./events.js";
import type { VotingHandler, VotingStartedEvent } from "./voting.js";
import type { NightHandler, NightStartedEvent } from "./night.js";
import type { PreGameHandler } from "./pregame.js";
import type { PhaseTimeoutDriver } from "./phase-timeout.js";
import type { HeadlessDayDriver } from "./headless-day.js";
import {
  eventProcessedKey,
  lastBlockKey,
  IDEMPOTENCY_TTL_SECONDS,
} from "./redis-keys.js";

export type DispatcherDeps = {
  redis: Redis;
  diamondByChain: Map<number, Hex>;
  /** Optional: when wired, VOTING_STARTED is routed here. Skipped otherwise. */
  votingHandler?: VotingHandler;
  /** Optional: when wired, NIGHT_STARTED is routed here. Skipped otherwise. */
  nightHandler?: NightHandler;
  /** Optional: when wired, GAME_STARTED / DECK_REVEALED drive the pre-game. */
  preGameHandler?: PreGameHandler;
  /**
   * Optional: when wired, an alive agent advances DAY/VOTING at the deadline
   * (forcePhaseTimeout) if no alive human's browser did — fixes stalls when the
   * last human dies or in all-agent games.
   */
  phaseTimeoutDriver?: PhaseTimeoutDriver;
  /**
   * Optional: when wired, on DAY_STARTED with no alive human the GM starts +
   * drives the agent discussion itself (and starts voting early) so a headless
   * day isn't a silent "Waiting for discussion..." screen. No-op for mixed games.
   */
  headlessDayDriver?: HeadlessDayDriver;
  /** Optional: post-game cleanup for leftover native funds on agent EOAs. */
  sweepAgents?: (chainId: number, roomId: string) => void | Promise<void>;
};

export type DispatchOutcome =
  | { kind: "duplicate"; reason: "event-already-processed" }
  | { kind: "dispatched"; handlerStub: AgentEvent["type"] }
  | { kind: "skipped"; reason: string };

export class AgentDispatcher {
  /** Per-room mutex so the pre-game (sequential by nature) never runs twice
   *  concurrently for one room — see runPreGame. */
  private readonly preGameMutexes = new Map<string, Mutex>();

  constructor(private readonly deps: DispatcherDeps) {}

  private mutexFor(roomKey: string): Mutex {
    let m = this.preGameMutexes.get(roomKey);
    if (!m) {
      m = new Mutex();
      this.preGameMutexes.set(roomKey, m);
    }
    return m;
  }

  /**
   * Drive the pre-game for one room, serialised. GAME_STARTED kicks it off; the
   * burst of DeckRevealed logs (incl. our own reveal txs) re-enter here and
   * either advance the next shuffle turn or — once the contract has flipped to
   * REVEAL (which emits no event of its own) — resolve roles + confirm. Both
   * handlers are idempotent against on-chain flags, so re-entry is safe.
   */
  private async runPreGame(event: AgentEvent): Promise<void> {
    const pg = this.deps.preGameHandler;
    if (!pg) return;
    const pgEvent = { chainId: event.chainId, roomId: event.roomId };
    await this.mutexFor(`${event.chainId}:${event.roomId}`).runExclusive(async () => {
      await pg
        .handleShuffling(pgEvent)
        .catch((err) =>
          logger.error(
            { err, roomId: event.roomId },
            "[agents] preGame.handleShuffling threw"
          )
        );
      await pg
        .handleReveal(pgEvent)
        .catch((err) =>
          logger.error(
            { err, roomId: event.roomId },
            "[agents] preGame.handleReveal threw"
          )
        );
    });
  }

  async dispatch(event: AgentEvent): Promise<DispatchOutcome> {
    const { redis } = this.deps;
    const key = eventProcessedKey(event.chainId, event.txHash, event.logIndex);

    // SET NX + EX: atomic "claim this event slot for IDEMPOTENCY_TTL_SECONDS".
    // Returns "OK" on first claim, null if the key already exists.
    const claimed = await redis.set(
      key,
      JSON.stringify({
        roomId: event.roomId,
        phaseId: event.phaseId,
        seenAt: Date.now(),
      }),
      "EX",
      IDEMPOTENCY_TTL_SECONDS,
      "NX"
    );

    if (claimed !== "OK") {
      logger.debug(
        { event: event.type, roomId: event.roomId, phaseId: event.phaseId },
        "[agents] duplicate event ignored"
      );
      return { kind: "duplicate", reason: "event-already-processed" };
    }

    // Advance cursor. We deliberately do NOT use MAX semantics here — the
    // listener processes logs in monotonic block order, and a backfill always
    // covers from `lastBlock - confirmations` so out-of-order writes can
    // only ever lower the cursor by N blocks, which is recoverable.
    const diamond = this.deps.diamondByChain.get(event.chainId);
    if (diamond) {
      await redis.set(
        lastBlockKey(event.chainId, diamond),
        String(event.blockNumber)
      );
    }

    logger.info(
      {
        event: event.type,
        chainId: event.chainId,
        roomId: event.roomId,
        phaseId: event.phaseId,
        blockNumber: event.blockNumber,
        txHash: event.txHash,
      },
      "[agents] dispatch (skeleton — no agent action wired yet)"
    );

    // Per-phase routing. Handlers run AFTER the event-level claim so a single
    // log delivery never starts two parallel handler invocations. Errors are
    // caught here — a failing handler must not leave the event marker absent
    // (which would re-trigger on the next listener restart), nor crash the
    // listener (which would stall the entire chain subscription).
    switch (event.type) {
      case "GAME_STARTED":
      case "DECK_REVEALED":
        await this.runPreGame(event);
        break;
      case "DAY_STARTED":
        // Agents speak per-turn (turnController, driven from discussionRoutes),
        // not in a burst here — so they read humans who spoke earlier in the day.
        this.deps.phaseTimeoutDriver?.start(event.chainId, BigInt(event.roomId));
        // Headless games have no browser to start/advance the discussion → an
        // agent does it. Fire-and-forget: it drives the whole day's chat (~tens
        // of seconds) and must not block event dispatch. No-op if a human is alive.
        if (this.deps.headlessDayDriver) {
          void this.deps.headlessDayDriver
            .onDayStarted({ chainId: event.chainId, roomId: event.roomId })
            .catch((err) =>
              logger.error(
                { err, roomId: event.roomId },
                "[agents] headlessDayDriver.onDayStarted threw"
              )
            );
        }
        break;
      case "VOTING_STARTED":
        if (this.deps.votingHandler) {
          // Fire-and-await: the listener already runs handleRawLog inside its
          // own try/catch (see listener.ts), so we can let the promise chain
          // back up and surface any exception via that path.
          await this.deps.votingHandler
            .handle(event as VotingStartedEvent)
            .catch((err) =>
              logger.error(
                { err, event: event.type, roomId: event.roomId },
                "[agents] votingHandler.handle threw"
              )
            );
        }
        // Watch the VOTING deadline — an alive agent finalizes if turnout is
        // incomplete and no human did (e.g. the only human died).
        this.deps.phaseTimeoutDriver?.start(event.chainId, BigInt(event.roomId));
        break;
      case "NIGHT_STARTED":
        if (this.deps.nightHandler) {
          await this.deps.nightHandler
            .handle(event as NightStartedEvent)
            .catch((err) =>
              logger.error(
                { err, event: event.type, roomId: event.roomId },
                "[agents] nightHandler.handle threw"
              )
            );
        }
        // NIGHT is resolved by the GM (doResolveNight), not by a deadline kick.
        this.deps.phaseTimeoutDriver?.stop(`${event.chainId}:${event.roomId}`);
        break;
      case "GAME_ENDED":
        this.deps.phaseTimeoutDriver?.stop(`${event.chainId}:${event.roomId}`);
        if (this.deps.sweepAgents) {
          void Promise.resolve(this.deps.sweepAgents(event.chainId, event.roomId)).catch(
            (err) =>
              logger.error(
                { err, roomId: event.roomId },
                "[agents] sweepAgents threw"
              )
          );
        }
        // TODO 4c: dispatch reveal-bundle for all agent traces in this room
        break;
    }

    return { kind: "dispatched", handlerStub: event.type };
  }
}

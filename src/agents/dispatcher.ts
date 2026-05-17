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
import { logger } from "../utils/logger.js";
import type { AgentEvent } from "./events.js";
import type { VotingHandler, VotingStartedEvent } from "./voting.js";
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
};

export type DispatchOutcome =
  | { kind: "duplicate"; reason: "event-already-processed" }
  | { kind: "dispatched"; handlerStub: AgentEvent["type"] }
  | { kind: "skipped"; reason: string };

export class AgentDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

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
      case "DAY_STARTED":
        // TODO 4d: dispatch DAY chat for each agent in roomId
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
        break;
      case "NIGHT_STARTED":
        // TODO 4f: dispatch NIGHT per active-role agent
        break;
      case "GAME_ENDED":
        // TODO 4c: dispatch reveal-bundle for all agent traces in this room
        break;
    }

    return { kind: "dispatched", handlerStub: event.type };
  }
}

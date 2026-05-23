/**
 * agents/turnController.ts — bridges the DAY discussion turn rotation to
 * agent speaking. Fully injected (configure) so it is unit-testable and so a
 * server with agents disabled is a no-op (configure never called).
 */
import type { Redis } from "ioredis";
import { agentTurnLockKey } from "./redis-keys.js";
import { logger } from "../utils/logger.js";

export interface TurnControllerDeps {
  redis: Pick<Redis, "set">;
  getCurrentSpeaker(
    chainId: number,
    roomId: string,
    dayCount: number
  ): Promise<{ addr: string; index: number; finished: boolean } | null>;
  isAgent(chainId: number, roomId: string, addr: string): Promise<boolean>;
  speakOneAgent(
    chainId: number,
    roomId: string,
    dayNumber: number,
    agentAddr: string
  ): Promise<{ handled: boolean }>;
  advanceAndBroadcast(chainId: number, roomId: string, dayCount: number): Promise<void>;
  /** Per-agent-turn time cap (ms) for inference+commit before the turn advances anyway. Default 15s. */
  capMs?: number;
}

const LOCK_TTL_SECONDS = 30;

class TurnController {
  private deps: TurnControllerDeps | null = null;

  configure(deps: TurnControllerDeps): void {
    this.deps = deps;
  }

  /** test-only */
  reset(): void {
    this.deps = null;
  }

  async onSpeakerChanged(chainId: number, roomId: string, dayCount: number): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    const capMs = deps.capMs ?? 15_000;

    // Bound the loop so a misconfigured advance can't spin forever.
    for (let guard = 0; guard < 64; guard++) {
      const cur = await deps.getCurrentSpeaker(chainId, roomId, dayCount).catch(() => null);
      if (!cur || cur.finished || !cur.addr) return;
      if (!(await deps.isAgent(chainId, roomId, cur.addr).catch(() => false))) return; // human turn

      const lock = await deps.redis.set(
        agentTurnLockKey(chainId, roomId, dayCount, cur.index),
        "1",
        "EX",
        LOCK_TTL_SECONDS,
        "NX"
      );
      if (lock !== "OK") return; // another worker owns this turn

      await Promise.race([
        deps
          .speakOneAgent(chainId, roomId, dayCount, cur.addr)
          .catch((err) =>
            logger.warn(
              { chainId, roomId, dayCount, agent: cur.addr, err: String(err?.message ?? err) },
              "[turnController] speakOneAgent failed — advancing turn anyway"
            )
          ),
        new Promise((r) => setTimeout(r, capMs)),
      ]);

      // If advancing fails, the turn stalls until a human poller advances it; the
      // held per-index lock stops this loop from re-running the same agent. Log so
      // the stall is observable.
      await deps.advanceAndBroadcast(chainId, roomId, dayCount).catch((err) =>
        logger.warn(
          { chainId, roomId, dayCount, err: String(err?.message ?? err) },
          "[turnController] advanceAndBroadcast failed — turn may stall"
        )
      );
      // loop: handle a possible consecutive agent speaker
    }
  }
}

export const turnController = new TurnController();

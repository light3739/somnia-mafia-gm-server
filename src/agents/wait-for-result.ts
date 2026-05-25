/**
 * agents/wait-for-result.ts — race a result EVENT against a getResult POLL.
 *
 * Why: `publicClient.watchContractEvent` on the Somnia RPC only sees logs from
 * the block where the watch was created FORWARD. The AgentRequester callback that
 * populates the result store often lands during the createRequest→receipt gap
 * (the subcommittee answers in ~2-5s), i.e. BEFORE the watch starts — so the
 * ResultReady event is in a block the watch never re-scans and is missed forever,
 * producing a 60s timeout even though the result is already on-chain. Proven on
 * prod (night inferToolsChat times out 4/4; voting inferChat ~1/3) — see
 * src/scripts/probe-night-latency.ts.
 *
 * Fix: keep the event watch (fast when it works) but also poll `getResult`, which
 * reads CURRENT store state via eth_call and cannot miss an already-landed result.
 * Resolve on whichever fires first; fall back to status 0 on timeout.
 */
import { logger } from "../utils/logger.js";

export interface WaitForLlmResultArgs {
  /** Hard ceiling; on expiry resolve(0) so the caller takes its deterministic fallback. */
  waitMs: number;
  /** getResult poll cadence. Default 1500ms. */
  pollMs?: number;
  /** For log correlation only. */
  requestId: bigint;
  /** Log namespace, e.g. "llm-tools" / "llm-chat". */
  label: string;
  /**
   * Subscribe to the Ready/Failed events. Call `onStatus(status)` when one
   * arrives, `onError(err)` on a watch error. Return an (idempotent) unwatch fn.
   */
  watchEvents: (
    onStatus: (status: number) => void,
    onError: (err: unknown) => void
  ) => () => void;
  /** Read current store state. Resolve to the status number if ready, else null. */
  pollReady: () => Promise<number | null>;
}

/** Resolves to the outcome status (0 = timed out / no result within waitMs). */
export function waitForLlmResult(args: WaitForLlmResultArgs): Promise<number> {
  const { waitMs, requestId, label } = args;
  const pollMs = args.pollMs ?? 1500;

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let unwatch: () => void = () => {};
    let poller: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      try {
        unwatch();
      } catch {
        /* unwatch is idempotent / best-effort */
      }
    };
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(status);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    timer = setTimeout(() => {
      logger.warn(
        { requestId: requestId.toString(), waitMs },
        `[agents/${label}] result timeout — falling back`
      );
      finish(0);
    }, waitMs);

    unwatch = args.watchEvents(
      (status) => finish(status),
      (err) => fail(err)
    );

    const tick = async () => {
      if (settled) return;
      try {
        const status = await args.pollReady();
        if (status !== null) finish(status);
      } catch {
        /* transient RPC hiccup — keep polling until the event or the deadline */
      }
    };
    poller = setInterval(() => void tick(), pollMs);
    // Immediate first check: the result may already be on-chain before the watch
    // even starts (the exact race this helper exists to defeat).
    void tick();
  });
}

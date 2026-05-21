/**
 * agents/retry.ts — minimal async retry.
 *
 * Used to retry AgentRequester.createRequest when it reverts during gas
 * estimation — i.e. BEFORE a tx is broadcast, so no value is spent and a retry
 * cannot double-spend. Callers must NOT wrap a call past the broadcast point.
 */
export interface RetryOpts {
  /** Extra attempts after the first (default 1 → up to 2 calls total). */
  retries?: number;
  /** Delay between attempts in ms (default 1500). Pass 0 in tests. */
  delayMs?: number;
  /** Return false to stop retrying a given error (default: always retry). */
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 1500;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) break;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

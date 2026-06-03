/**
 * agents/tx-serializer.ts — per-wallet transaction serialization.
 *
 * Agents fire several txs from one EOA across fast/overlapping phases (vote +
 * vote-commit + night-commit + inference createRequests). viem assigns nonces
 * via getTransactionCount("pending") per tx; two txs built before either reaches
 * the mempool grab the SAME pending nonce → one is dropped (prod room 36: a
 * voting audit-commit was evicted at nonce 8 by the night-commit → 120s receipt
 * timeout). The frontend already solved this for humans (useTransactionEngine's
 * `enqueueTx` queue + nonce retry); this is the server-side port for agents.
 *
 * `runExclusive` chains calls per key (agent address) so the next tx is only
 * BUILT after the previous one has been broadcast — by which point the previous
 * nonce is in the pending pool and the next correctly gets nonce+1. Different
 * wallets run concurrently (each has its own nonce stream).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

const queues = new Map<string, Promise<unknown>>();
/** Per-wallet local nonce high-water mark (Somnia's pending nonce lags behind a
 * just-broadcast tx, so we cannot re-fetch it between rapid txs — track locally). */
const localNonce = new Map<string, number>();
/** Per-wallet timestamp of the last broadcast, so we only trust the local
 * high-water inside the brief pending-lag window (see pickNonce). */
const lastBroadcastAt = new Map<string, number>();
const publicClients = new Map<string, PublicClient>();

/** How long after a broadcast Somnia's pending count may still lag it. Inside
 * this window the local high-water wins; outside it the chain heals the gap. */
const NONCE_LAG_WINDOW_MS = Number(process.env.NONCE_LAG_WINDOW_MS ?? 3000);

function publicClientFor(chain: Chain, rpcUrl: string): PublicClient {
  let pc = publicClients.get(rpcUrl);
  if (!pc) {
    pc = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
    publicClients.set(rpcUrl, pc);
  }
  return pc;
}

/**
 * Decide the nonce to broadcast with, given the chain's pending count and our
 * locally-tracked high-water mark.
 *
 * Somnia's `getTransactionCount('pending')` LAGS a just-broadcast tx (it briefly
 * under-counts), so within `lagWindowMs` of our last broadcast we trust the local
 * high-water to avoid two burst txs grabbing the same nonce (agent collisions).
 *
 * But the node also silently EVICTS gapped/future txs: if one of our txs is
 * accepted then dropped, `localHighWater` is left permanently ahead of the chain
 * while `chainPending` correctly falls back. `Math.max` alone would pin every
 * retry above the gap forever (the room-66 GM night-resolve freeze). So OUTSIDE
 * the lag window we trust `chainPending` — a stale-high local value heals down
 * instead of climbing. `chainPending` already counts genuinely-pending txs, so we
 * never reuse a live nonce; upward drift is respected in both branches.
 */
export function pickNonce(
  chainPending: number,
  localHighWater: number,
  msSinceLastBroadcast: number,
  lagWindowMs: number
): number {
  const recent = msSinceLastBroadcast < lagWindowMs;
  return recent ? Math.max(chainPending, localHighWater) : chainPending;
}

/** Run `fn` after all prior runExclusive calls for the same key have settled. */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = key.toLowerCase();
  const prev = queues.get(k) ?? Promise.resolve();
  // Run fn whether the previous call resolved or rejected (a failed tx must not
  // wedge the wallet's queue forever).
  const run = prev.then(fn, fn);
  // Keep the chain alive but swallowed so one rejection doesn't reject the queue.
  queues.set(
    k,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/**
 * A viem WalletClient whose `writeContract` is serialized per account AND uses a
 * locally-managed nonce. Drop-in replacement for `createWalletClient` at agent tx
 * sites: concurrent writes from the same EOA run one-at-a-time and each gets an
 * explicit, strictly-increasing nonce — so they no longer collide (prod room 36)
 * even though Somnia's `getTransactionCount(pending)` lags a just-broadcast tx.
 *
 * The nonce is chosen by `pickNonce` inside the queue: the local high-water wins
 * only within the pending-lag window after our last broadcast (burst safety),
 * otherwise the chain's pending count wins so a dropped/evicted tx heals the gap
 * instead of wedging the wallet forever (see pickNonce). On a broadcast failure
 * the reservation is rolled back so the nonce isn't wasted.
 */
/** Test seam: inject the pending-nonce reader and the raw broadcast so the nonce
 * logic can be driven end-to-end without a live RPC. Both default to the real
 * viem clients, so production call sites pass nothing and are unchanged. */
export interface SerializerDeps {
  getPendingNonce?: (address: `0x${string}`) => Promise<number>;
  rawWrite?: (args: any) => Promise<`0x${string}`>;
}

export function serializedWalletClient(
  account: Account,
  chain: Chain,
  rpcUrl: string,
  deps?: SerializerDeps
): WalletClient<Transport, Chain, Account> {
  // Explicit chain-bound type: keeps writeContract({...}) from demanding `chain`
  // per-call (mirrors createWalletClient) without the inferred type blowing the
  // TS serialization limit (TS7056).
  const base = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const key = account.address.toLowerCase();
  const pc = publicClientFor(chain, rpcUrl);
  const getPendingNonce =
    deps?.getPendingNonce ??
    ((address: `0x${string}`) => pc.getTransactionCount({ address, blockTag: "pending" }));
  const originalWrite =
    deps?.rawWrite ?? (base.writeContract.bind(base) as (args: any) => Promise<`0x${string}`>);

  (base as unknown as { writeContract: (args: any) => Promise<`0x${string}`> }).writeContract = (
    args: any
  ) =>
    runExclusive(key, async () => {
      const chainPending = await getPendingNonce(account.address as `0x${string}`);
      const now = Date.now();
      const nonce = pickNonce(
        chainPending,
        localNonce.get(key) ?? 0,
        now - (lastBroadcastAt.get(key) ?? 0),
        NONCE_LAG_WINDOW_MS
      );
      localNonce.set(key, nonce + 1); // reserve before broadcast
      lastBroadcastAt.set(key, now);
      try {
        return await originalWrite({ ...args, nonce });
      } catch (err) {
        // Broadcast failed → the nonce wasn't consumed → roll back so it's reused.
        if ((localNonce.get(key) ?? 0) === nonce + 1) localNonce.set(key, nonce);
        throw err;
      }
    });
  return base;
}

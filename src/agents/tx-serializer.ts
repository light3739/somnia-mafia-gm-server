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
const publicClients = new Map<string, PublicClient>();

function publicClientFor(chain: Chain, rpcUrl: string): PublicClient {
  let pc = publicClients.get(rpcUrl);
  if (!pc) {
    pc = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
    publicClients.set(rpcUrl, pc);
  }
  return pc;
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
 * The nonce is `max(chainPending, localHighWater)` reserved inside the queue, so
 * it self-heals from external txs / drift while never reusing a live nonce. On a
 * broadcast failure the reservation is rolled back so the nonce isn't wasted.
 */
export function serializedWalletClient(
  account: Account,
  chain: Chain,
  rpcUrl: string
): WalletClient<Transport, Chain, Account> {
  // Explicit chain-bound type: keeps writeContract({...}) from demanding `chain`
  // per-call (mirrors createWalletClient) without the inferred type blowing the
  // TS serialization limit (TS7056).
  const base = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const key = account.address.toLowerCase();
  const pc = publicClientFor(chain, rpcUrl);
  const originalWrite = base.writeContract.bind(base) as (args: any) => Promise<`0x${string}`>;

  (base as unknown as { writeContract: (args: any) => Promise<`0x${string}`> }).writeContract = (
    args: any
  ) =>
    runExclusive(key, async () => {
      const chainPending = await pc.getTransactionCount({
        address: account.address as `0x${string}`,
        blockTag: "pending",
      });
      const nonce = Math.max(chainPending, localNonce.get(key) ?? 0);
      localNonce.set(key, nonce + 1); // reserve before broadcast
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

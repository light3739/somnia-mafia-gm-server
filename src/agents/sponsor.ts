/**
 * agents/sponsor.ts — Sponsor wallet for funding agent EOAs.
 *
 * Agents are HD-derived addresses with zero balance. To joinRoom they need:
 *   - entryFee (platform fee, taken by the contract)
 *   - depositPerPlayer (refundable on game end, locked during play)
 *   - gas reserve for subsequent vote + commit + inferString deposits
 *
 * The sponsor wallet is a single hot wallet (env: AGENT_SPONSOR_PRIVATE_KEY)
 * that pre-funds each agent at fill-room time. For testnet this is the clean
 * key memory tracks at `0x3D9297...`; for mainnet a fresh key with a
 * top-up budget should be used.
 *
 * Distinct from `GM_PRIVATE_KEY` — the GM signs phase advances and
 * registerAgent calls (no value transfer); the sponsor only sends value.
 */
import {
  createWalletClient,
  http,
  parseGwei,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChainConfig } from "../chain.js";
import { logger } from "../utils/logger.js";

function loadSponsorKey(): Hex {
  const raw = process.env.AGENT_SPONSOR_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      "AGENT_SPONSOR_PRIVATE_KEY missing — required for /agents/fill-room"
    );
  }
  // Same defensive strip the spike used: tolerate quotes / trailing junk like the
  // observed "ns" suffix in operator .env files.
  const m = raw.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
  if (!m) throw new Error("AGENT_SPONSOR_PRIVATE_KEY is not a valid 64-hex key");
  const hex = m[0].startsWith("0x") ? m[0] : `0x${m[0]}`;
  return hex as Hex;
}

let cached:
  | {
      account: ReturnType<typeof privateKeyToAccount>;
      walletByChain: Map<number, ReturnType<typeof createWalletClient>>;
    }
  | null = null;

function ensure(): NonNullable<typeof cached> {
  if (cached) return cached;
  const account = privateKeyToAccount(loadSponsorKey());
  cached = { account, walletByChain: new Map() };
  logger.info(
    { sponsor: account.address },
    "[agents/sponsor] sponsor wallet initialised"
  );
  return cached;
}

export function getSponsorAddress(): Address {
  return ensure().account.address;
}

function walletFor(chainId: number) {
  const c = ensure();
  const existing = c.walletByChain.get(chainId);
  if (existing) return existing;
  const { public: publicClient } = getChainConfig(chainId);
  const chainObj = publicClient.chain as Chain | undefined;
  if (!chainObj) throw new Error(`chain ${chainId} has no .chain on publicClient`);
  const w = createWalletClient({
    account: c.account,
    chain: chainObj,
    transport: http(chainObj.rpcUrls.default.http[0]),
  });
  c.walletByChain.set(chainId, w);
  return w;
}

export interface TopUpOpts {
  gasPriceGwei?: number;
  /** If set, waits for the receipt before returning. Default true. */
  waitForReceipt?: boolean;
  receiptTimeoutMs?: number;
}

/**
 * Send `valueWei` from the sponsor to `to`. Returns the tx hash. By default
 * waits for the receipt so callers can sequence the next tx (joinRoom) with
 * confidence the funds have landed.
 */
export async function topUp(
  chainId: number,
  to: Address,
  valueWei: bigint,
  opts: TopUpOpts = {}
): Promise<Hex> {
  const wallet = walletFor(chainId);
  const { public: publicClient } = getChainConfig(chainId);
  const gasPriceGwei = opts.gasPriceGwei ?? 10;
  const waitForReceipt = opts.waitForReceipt ?? true;
  const receiptTimeoutMs = opts.receiptTimeoutMs ?? 120_000;

  const hash = (await (wallet as any).sendTransaction({
    to,
    value: valueWei,
    gasPrice: parseGwei(String(gasPriceGwei)),
  })) as Hex;

  if (waitForReceipt) {
    const receipt = await Promise.race([
      publicClient.waitForTransactionReceipt({ hash }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`topUp receipt timeout (${hash})`)),
          receiptTimeoutMs
        )
      ),
    ]);
    // A reverted top-up means the agent never received funds — caller must
    // know so the join phase doesn't run with a still-empty wallet.
    if ((receipt as any).status !== "success") {
      throw new Error(`topUp reverted on chain (tx ${hash})`);
    }
  }
  return hash;
}

/**
 * Convenience: returns the sponsor's current balance on the given chain.
 * Useful for pre-flight checks before kicking off a fill-room batch.
 */
export async function getSponsorBalance(chainId: number): Promise<bigint> {
  const { public: publicClient } = getChainConfig(chainId);
  return publicClient.getBalance({ address: ensure().account.address });
}

/**
 * agents/sweep.ts - Return leftover testnet funds from HD agent EOAs to sponsor.
 *
 * Agent wallets are sponsor-funded hot EOAs. They pay their own game tx gas and
 * Somnia AgentRequester deposits. After a room ends, leftover native balance on
 * those EOAs should go back to the sponsor so hackathon testing does not leak
 * STT across hundreds of derived wallets.
 */
import {
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  parseGwei,
  type Address,
  type Chain,
  type HDAccount,
  type Hex,
} from "viem";
import { getChainConfig } from "../chain.js";
import { logger } from "../utils/logger.js";
import { AGENT_REGISTRY_ABI, DIAMOND_VOTE_ABI } from "./registry-abi.js";
import { getSponsorAddress } from "./sponsor.js";
import {
  loadOrGenerateMnemonic,
  matchWalletsToAgents,
  type AgentWallet,
} from "./wallets.js";

export const AGENT_TESTNET_CHAIN_ID = 50312;

const PHASE_ENDED = 6;
const ZERO_TOKEN: Address = "0x0000000000000000000000000000000000000000";
const TRANSFER_GAS = 21_000n;
const CLAIM_REFUND_GAS = 180_000n;

const REFUNDS_ABI = parseAbi([
  "function claimRefund(address token)",
  "function getPendingRefund(address user, address token) view returns (uint256)",
]);

export type SweepOutcome =
  | {
      status: "swept";
      idx: number;
      agent: Address;
      sweptWei: string;
      balanceBeforeWei: string;
      balanceAfterWei: string;
      txHash: Hex;
      claimTxHash?: Hex;
      pendingRefundWei?: string;
    }
  | {
      status:
        | "skipped-no-balance"
        | "skipped-unmatched-wallet"
        | "skipped-claim-insufficient-gas"
        | "sweep-failed";
      idx?: number;
      agent: Address;
      balanceWei?: string;
      pendingRefundWei?: string;
      err?: string;
    };

export interface SweepRoomResult {
  roomId: string;
  chainId: number;
  sponsor: Address;
  outcomes: SweepOutcome[];
}

export interface SweepRoomRequest {
  chainId: number;
  roomId: bigint;
  /** Delay callers can override via env by changing reserve, not code. */
  gasPriceGwei?: number;
}

function assertTestnetOnly(chainId: number) {
  if (chainId !== AGENT_TESTNET_CHAIN_ID) {
    throw new Error("agent funding is testnet-only (chainId 50312)");
  }
}

function sweepReserveWei(gasPriceWei: bigint): bigint {
  const dust = BigInt(
    process.env.AGENT_SWEEP_DUST_WEI ?? parseEther("0.001").toString()
  );
  return TRANSFER_GAS * gasPriceWei + dust;
}

function claimReserveWei(gasPriceWei: bigint): bigint {
  return CLAIM_REFUND_GAS * gasPriceWei + sweepReserveWei(gasPriceWei);
}

function walletFor(account: HDAccount, chainObj: Chain, rpcUrl: string) {
  return createWalletClient({
    account,
    chain: chainObj,
    transport: http(rpcUrl),
  });
}

async function waitForReceiptOrThrow(publicClient: any, hash: Hex, label: string) {
  const receipt = await Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} receipt timeout (${hash})`)), 120_000)
    ),
  ]);
  if ((receipt as any).status !== "success") {
    throw new Error(`${label} reverted (tx ${hash})`);
  }
  return receipt;
}

async function maybeClaimPendingRefund(args: {
  publicClient: any;
  wallet: ReturnType<typeof walletFor>;
  diamond: Address;
  agent: Address;
  balanceWei: bigint;
  gasPriceWei: bigint;
}): Promise<{ pendingRefundWei: bigint; claimTxHash?: Hex; skippedInsufficientGas?: boolean }> {
  const pendingRefundWei = (await args.publicClient.readContract({
    address: args.diamond,
    abi: REFUNDS_ABI,
    functionName: "getPendingRefund",
    args: [args.agent, ZERO_TOKEN],
  })) as bigint;

  if (pendingRefundWei === 0n) return { pendingRefundWei };
  if (args.balanceWei < claimReserveWei(args.gasPriceWei)) {
    return { pendingRefundWei, skippedInsufficientGas: true };
  }

  const claimTxHash = (await args.wallet.writeContract({
    address: args.diamond,
    abi: REFUNDS_ABI,
    functionName: "claimRefund",
    args: [ZERO_TOKEN],
    gas: CLAIM_REFUND_GAS,
    gasPrice: args.gasPriceWei,
  } as any)) as Hex;
  await waitForReceiptOrThrow(args.publicClient, claimTxHash, "claimRefund");
  return { pendingRefundWei, claimTxHash };
}

export async function sweepRoomAgentFunds(
  req: SweepRoomRequest
): Promise<SweepRoomResult> {
  const { chainId, roomId } = req;
  assertTestnetOnly(chainId);

  const { public: publicClient, diamond } = getChainConfig(chainId);
  const chainObj = publicClient.chain as Chain | undefined;
  if (!chainObj) throw new Error(`chain ${chainId} has no .chain on publicClient`);
  const rpcUrl = chainObj.rpcUrls.default.http[0];
  const sponsor = getSponsorAddress();
  const gasPriceWei = parseGwei(String(req.gasPriceGwei ?? process.env.TX_GAS_PRICE_GWEI ?? "10"));

  const room: any = await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getRoom",
    args: [roomId],
  });
  if (Number(room.phase) !== PHASE_ENDED) {
    throw new Error(`room ${roomId} not ended (phase ${room.phase})`);
  }

  const players = (await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getPlayers",
    args: [roomId],
  })) as { wallet: Address }[];

  const agentFlags = await Promise.all(
    players.map(async (p) => ({
      addr: p.wallet,
      isAgent: (await publicClient.readContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "isAgent",
        args: [roomId, p.wallet],
      })) as boolean,
    }))
  );
  const agentAddrs = agentFlags.filter((p) => p.isAgent).map((p) => p.addr);

  const mnemonic = loadOrGenerateMnemonic();
  const maxDerive = Number(
    process.env.AGENT_SWEEP_MAX_DERIVE ?? String(Math.max(12, players.length + 3))
  );
  const matched = matchWalletsToAgents(mnemonic, roomId, agentAddrs, maxDerive);
  const byAddr = new Map<string, AgentWallet>(
    matched.map((w) => [w.address.toLowerCase(), w])
  );
  const outcomes: SweepOutcome[] = [];

  for (const agentAddr of agentAddrs) {
    const wallet = byAddr.get(agentAddr.toLowerCase());
    if (!wallet) {
      outcomes.push({ status: "skipped-unmatched-wallet", agent: agentAddr });
      continue;
    }

    try {
      const client = walletFor(wallet.account, chainObj, rpcUrl);
      let balance = await publicClient.getBalance({ address: wallet.address });
      const claim = await maybeClaimPendingRefund({
        publicClient,
        wallet: client,
        diamond,
        agent: wallet.address,
        balanceWei: balance,
        gasPriceWei,
      });

      if (claim.skippedInsufficientGas) {
        outcomes.push({
          status: "skipped-claim-insufficient-gas",
          idx: wallet.idx,
          agent: wallet.address,
          balanceWei: balance.toString(),
          pendingRefundWei: claim.pendingRefundWei.toString(),
        });
        continue;
      }

      if (claim.claimTxHash) {
        balance = await publicClient.getBalance({ address: wallet.address });
      }

      const reserve = sweepReserveWei(gasPriceWei);
      if (balance <= reserve) {
        outcomes.push({
          status: "skipped-no-balance",
          idx: wallet.idx,
          agent: wallet.address,
          balanceWei: balance.toString(),
          pendingRefundWei: claim.pendingRefundWei.toString(),
        });
        continue;
      }

      const balanceBefore = balance;
      const value = balance - reserve;
      const txHash = (await client.sendTransaction({
        to: sponsor,
        value,
        gas: TRANSFER_GAS,
        gasPrice: gasPriceWei,
      } as any)) as Hex;
      await waitForReceiptOrThrow(publicClient, txHash, "agent sweep");
      const balanceAfter = await publicClient.getBalance({ address: wallet.address });

      outcomes.push({
        status: "swept",
        idx: wallet.idx,
        agent: wallet.address,
        sweptWei: value.toString(),
        balanceBeforeWei: balanceBefore.toString(),
        balanceAfterWei: balanceAfter.toString(),
        txHash,
        claimTxHash: claim.claimTxHash,
        pendingRefundWei: claim.pendingRefundWei.toString(),
      });
    } catch (err: any) {
      outcomes.push({
        status: "sweep-failed",
        idx: wallet.idx,
        agent: wallet.address,
        err: String(err?.message ?? err),
      });
    }
  }

  logger.info(
    {
      chainId,
      roomId: roomId.toString(),
      sponsor,
      swept: outcomes.filter((o) => o.status === "swept").length,
      totalAgents: agentAddrs.length,
    },
    "[agents/sweep] room sweep complete"
  );

  return { roomId: roomId.toString(), chainId, sponsor, outcomes };
}

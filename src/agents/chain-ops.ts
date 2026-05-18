/**
 * agents/chain-ops.ts — Production VoteChainOps factory.
 *
 * Bridges the dependency-injected VoteChainOps interface used by VotingHandler
 * to real viem clients constructed from src/chain.ts. Kept separate from
 * voting.ts so the test surface (which mocks VoteChainOps wholesale) doesn't
 * pull in chain.ts (which fails fast on a missing GM_PRIVATE_KEY in env).
 *
 * Per-agent wallet clients are created on demand — each agent EOA needs its
 * own nonce stream, so we cannot share a single walletClient across them.
 */
import {
  createWalletClient,
  http,
  parseGwei,
  type Address,
  type Chain,
  type HDAccount,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getChainConfig } from "../chain.js";
import { logger } from "../utils/logger.js";
import {
  AGENT_REGISTRY_ABI,
  DIAMOND_VOTE_ABI,
} from "./registry-abi.js";
import type {
  PlayerSnapshot,
  RoomSnapshot,
  VoteChainOps,
} from "./voting.js";

/** Empirical 120s timeout matches the GM tx helpers in chain.ts. */
const TX_RECEIPT_TIMEOUT_MS = 120_000;

/**
 * Wait for the receipt AND assert it succeeded. A reverted tx returns a
 * receipt with status='reverted' — the old code merely awaited and swallowed,
 * which let callers record a "successful" tx hash for a tx that never
 * actually landed. Now we throw so caller surfaces vote-failed / commit-failed
 * instead of silently lying in the trace audit.
 */
async function waitForReceiptOrRevert(
  publicClient: PublicClient,
  hash: Hex,
  label: string
): Promise<void> {
  const receipt = await Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`receipt timeout after ${TX_RECEIPT_TIMEOUT_MS}ms (${label} ${hash})`)
          ),
        TX_RECEIPT_TIMEOUT_MS
      )
    ),
  ]);
  if ((receipt as any).status !== "success") {
    throw new Error(`${label} reverted on chain (tx ${hash})`);
  }
}

export function makeVoteChainOps(chainId: number): VoteChainOps {
  const { public: publicClient, diamond } = getChainConfig(chainId);
  const chainObj = publicClient.chain as Chain | undefined;
  if (!chainObj) {
    throw new Error(`[agents/chain-ops] chain ${chainId} publicClient has no .chain`);
  }
  const rpcUrl = chainObj.rpcUrls.default.http[0];

  return {
    chainId,
    diamond,
    publicClient,

    async getRoom(roomId): Promise<RoomSnapshot> {
      const room: any = await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "getRoom",
        args: [roomId],
      });
      return {
        phase: Number(room.phase),
        dayCount: Number(room.dayCount),
        aliveCount: Number(room.aliveCount),
      };
    },

    async getPlayers(roomId): Promise<readonly PlayerSnapshot[]> {
      const players: any = await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "getPlayers",
        args: [roomId],
      });
      return players.map((p: any) => ({
        wallet: p.wallet as Address,
        flags: Number(p.flags),
      }));
    },

    async isAgent(roomId, addr) {
      return publicClient.readContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "isAgent",
        args: [roomId, addr],
      }) as Promise<boolean>;
    },

    async getAgentTraceCommitment(roomId, phaseId, agent) {
      return publicClient.readContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "getAgentTraceCommitment",
        args: [roomId, phaseId, agent],
      }) as Promise<Hex>;
    },

    async sendVote(agent, roomId, target, gasPriceGwei) {
      const wallet = createWalletClient({
        account: agent,
        chain: chainObj,
        transport: http(rpcUrl),
      });
      const hash = await wallet.writeContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "vote",
        args: [roomId, target],
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      // Throws on revert / timeout so caller's catch surfaces vote-failed
      // instead of recording a phantom voteTxHash in the trace.
      await waitForReceiptOrRevert(publicClient, hash, "vote");
      logger.debug({ hash, agent: agent.address }, "[agents/chain-ops] vote receipt success");
      return hash;
    },

    async sendCommitInference(
      agent,
      roomId,
      phaseId,
      actionHash,
      traceCommitment,
      gasPriceGwei
    ) {
      const wallet = createWalletClient({
        account: agent,
        chain: chainObj,
        transport: http(rpcUrl),
      });
      const hash = await wallet.writeContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "commitAgentInference",
        args: [roomId, phaseId, actionHash, traceCommitment],
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "commitAgentInference");
      logger.debug({ hash, agent: agent.address }, "[agents/chain-ops] commit receipt success");
      return hash;
    },

    buildAgentWalletClient(agent: HDAccount): WalletClient {
      return createWalletClient({
        account: agent,
        chain: chainObj,
        transport: http(rpcUrl),
      });
    },
  };
}

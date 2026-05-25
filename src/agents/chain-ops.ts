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
  parseGwei,
  type Address,
  type Chain,
  type HDAccount,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getChainConfig } from "../chain.js";
import { serializedWalletClient } from "./tx-serializer.js";
import { logger } from "../utils/logger.js";
import {
  AGENT_REGISTRY_ABI,
  DIAMOND_VOTE_ABI,
  PREGAME_ABI,
} from "./registry-abi.js";
import type {
  PlayerSnapshot,
  RoomSnapshot,
  VoteChainOps,
} from "./voting.js";
import type { Groth16Proof } from "./groth16.js";
import type {
  PlayerPregameSnapshot,
  PreGameChainOps,
  RoomPregameSnapshot,
} from "./pregame.js";

/**
 * 4d DAY chat — chain-side methods the DayHandler needs in addition to the
 * VoteChainOps surface. Lives here (not in day.ts) so the existing factory
 * can satisfy both interfaces via structural typing.
 */
export interface DayChainOpsExtras {
  sendCommitMessageV2(
    agent: HDAccount,
    roomId: bigint,
    phaseId: Hex,
    messageHash: Hex,
    gasPriceGwei: number
  ): Promise<Hex>;
  getAgentMessageHash(
    roomId: bigint,
    phaseId: Hex,
    agent: Address
  ): Promise<Hex>;
  getSponsorBalanceWei(): Promise<bigint>;
  /**
   * Agent calls forcePhaseTimeout(roomId) from its own EOA — agents are
   * isPlayerInRoom, so this is the same call a human's browser makes at the
   * deadline. Reverts (TooEarly / phase already advanced) are surfaced so the
   * caller can treat them as "someone else advanced it" no-ops.
   */
  sendForcePhaseTimeout(
    agent: HDAccount,
    roomId: bigint,
    gasPriceGwei: number
  ): Promise<Hex>;
  /**
   * Agent calls startVoting(roomId) from its own EOA to advance DAY→VOTING
   * EARLY (the contract only requires an active participant + DAY phase, NOT the
   * deadline — same call a player's browser makes when discussion finishes). Used
   * by the headless-day driver so an all-agent day doesn't sit silent until the
   * deadline. Reverts (WrongPhase = already advanced) are surfaced as no-ops.
   */
  sendStartVoting(
    agent: HDAccount,
    roomId: bigint,
    gasPriceGwei: number
  ): Promise<Hex>;
  /**
   * Agent EOA submits endGameZK(roomId, proof) on-chain to finalise the game
   * with a Groth16 ZK proof. Requires 8M gas cap — the on-chain
   * calculatePublicStateHash runs 31 Poseidon2 external calls + a Groth16
   * verify; auto-estimate under-budgets this on Somnia.
   */
  endGameZKAsAgent(
    roomId: bigint,
    proof: Groth16Proof,
    agent: HDAccount
  ): Promise<{ hash: Hex }>;
}

/** Empirical 120s timeout matches the GM tx helpers in chain.ts. */
const TX_RECEIPT_TIMEOUT_MS = 120_000;

/**
 * Explicit gas caps for agent write txs. Any tx that can be the one that
 * FINALIZES a phase (tally+eliminate+advance, role-confirm→DAY, reveal→REVEAL,
 * shuffle setup) is far heavier than its base case; viem's auto-estimate
 * under-budgets it when the state shifts between estimate and execution →
 * OUT_OF_GAS → the action is lost (vote → "AFK"; forcePhaseTimeout → the game
 * stalls with no live human). Mirror the frontend's KNOWN_LIMITS. Caps only —
 * gas is pay-per-use, so over-budgeting a light call costs nothing.
 */
const GAS = {
  vote: 8_000_000n,
  startVoting: 8_000_000n,
  forcePhaseTimeout: 8_000_000n,
  startGame: 8_000_000n,
  commitAndConfirmRole: 3_000_000n,
  revealDeck: 3_000_000n,
  shareKeysToAll: 3_000_000n,
  commitDeck: 2_000_000n,
  commitInference: 2_000_000n,
  commitMessage: 2_000_000n,
  endGameZK: 8_000_000n, // calculatePublicStateHash runs 31 Poseidon2 external calls + Groth16 verify — must not OOG
} as const;

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

export function makeVoteChainOps(chainId: number): VoteChainOps & DayChainOpsExtras {
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
        phaseDeadline: Number(room.phaseDeadline),
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
        nickname: typeof p.nickname === "string" ? p.nickname : undefined,
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
      const wallet = serializedWalletClient(agent, chainObj, rpcUrl);
      const hash = await wallet.writeContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "vote",
        args: [roomId, target],
        gas: GAS.vote, // heavy when this vote finalizes the round — see GAS note
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      // Throws on revert / timeout so caller's catch surfaces vote-failed
      // instead of recording a phantom voteTxHash in the trace.
      await waitForReceiptOrRevert(publicClient, hash, "vote");
      logger.debug({ hash, agent: agent.address }, "[agents/chain-ops] vote receipt success");
      return hash;
    },

    async sendForcePhaseTimeout(agent, roomId, gasPriceGwei) {
      const wallet = serializedWalletClient(agent, chainObj, rpcUrl);
      const hash = await wallet.writeContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "forcePhaseTimeout",
        args: [roomId],
        gas: GAS.forcePhaseTimeout, // advances the phase (heavy) — must not OOG
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "forcePhaseTimeout");
      logger.debug(
        { hash, agent: agent.address },
        "[agents/chain-ops] forcePhaseTimeout receipt success"
      );
      return hash;
    },

    async sendStartVoting(agent, roomId, gasPriceGwei) {
      const wallet = serializedWalletClient(agent, chainObj, rpcUrl);
      const hash = await wallet.writeContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "startVoting",
        args: [roomId],
        gas: GAS.startVoting, // loops all players to clear vote flags — must not OOG
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "startVoting");
      logger.debug(
        { hash, agent: agent.address },
        "[agents/chain-ops] startVoting receipt success"
      );
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
      const wallet = serializedWalletClient(agent, chainObj, rpcUrl);
      const hash = await wallet.writeContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "commitAgentInference",
        args: [roomId, phaseId, actionHash, traceCommitment],
        gas: GAS.commitInference,
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "commitAgentInference");
      logger.debug({ hash, agent: agent.address }, "[agents/chain-ops] commit receipt success");
      return hash;
    },

    buildAgentWalletClient(agent: HDAccount): WalletClient {
      return serializedWalletClient(agent, chainObj, rpcUrl);
    },

    // ---- 4d DAY chat surface ----

    async sendCommitMessageV2(
      agent,
      roomId,
      phaseId,
      messageHash,
      gasPriceGwei
    ) {
      const wallet = serializedWalletClient(agent, chainObj, rpcUrl);
      const hash = await wallet.writeContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "commitAgentMessageV2",
        args: [roomId, phaseId, messageHash],
        gas: GAS.commitMessage,
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "commitAgentMessageV2");
      logger.debug(
        { hash, agent: agent.address },
        "[agents/chain-ops] commitAgentMessageV2 receipt success"
      );
      return hash;
    },

    async getAgentMessageHash(roomId, phaseId, agent) {
      return publicClient.readContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "getAgentMessageHash",
        args: [roomId, phaseId, agent],
      }) as Promise<Hex>;
    },

    async getSponsorBalanceWei() {
      // Re-export of the canonical sponsor balance probe from sponsor.ts.
      // Imported lazily to avoid circular import (sponsor.ts depends on chain.ts).
      const { getSponsorBalance } = await import("./sponsor.js");
      return getSponsorBalance(chainId);
    },

    async endGameZKAsAgent(roomId, proof, agent) {
      const wallet = serializedWalletClient(agent, chainObj, rpcUrl);
      const hash = await wallet.writeContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI, // endGameZK was added to DIAMOND_VOTE_ABI in registry-abi.ts
        functionName: "endGameZK",
        args: [
          roomId,
          proof.a as [bigint, bigint],
          proof.b as [[bigint, bigint], [bigint, bigint]],
          proof.c as [bigint, bigint],
          proof.input as [bigint, bigint, bigint, bigint, bigint, bigint],
        ],
        gas: GAS.endGameZK, // Poseidon2 ×31 + Groth16 verify — must not OOG
      });
      await waitForReceiptOrRevert(publicClient, hash, "endGameZK");
      logger.debug(
        { hash, agent: agent.address },
        "[agents/chain-ops] endGameZK receipt success"
      );
      return { hash };
    },
  };
}

/**
 * 4j pre-game chain ops — real viem wiring for PreGameHandler. Mirrors
 * makeVoteChainOps: reads off the shared publicClient, each write builds a
 * per-agent walletClient (own nonce stream) and asserts the receipt succeeded.
 */
export function makePreGameChainOps(chainId: number): PreGameChainOps {
  const { public: publicClient, diamond } = getChainConfig(chainId);
  const chainObj = publicClient.chain as Chain | undefined;
  if (!chainObj) {
    throw new Error(`[agents/chain-ops] chain ${chainId} publicClient has no .chain`);
  }
  const rpcUrl = chainObj.rpcUrls.default.http[0];
  // No return annotation: the inferred concrete client keeps `chain` bound so
  // writeContract doesn't demand it per-call (mirrors makeVoteChainOps).
  const walletFor = (agent: HDAccount) =>
    serializedWalletClient(agent, chainObj, rpcUrl);

  return {
    chainId,
    diamond,

    async getRoom(roomId): Promise<RoomPregameSnapshot> {
      const room: any = await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "getRoom",
        args: [roomId],
      });
      return {
        phase: Number(room.phase),
        playersCount: Number(room.playersCount),
        aliveCount: Number(room.aliveCount),
        currentShufflerIndex: Number(room.currentShufflerIndex),
        confirmedCount: Number(room.confirmedCount),
        keysSharedCount: Number(room.keysSharedCount),
        revealedCount: Number(room.revealedCount),
        phaseDeadline: Number(room.phaseDeadline),
      };
    },

    async getPlayers(roomId): Promise<readonly PlayerPregameSnapshot[]> {
      const players: any = await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "getPlayers",
        args: [roomId],
      });
      return players.map((p: any) => ({
        wallet: p.wallet as Address,
        flags: Number(p.flags),
        publicKey: (p.publicKey ?? "0x") as Hex,
      }));
    },

    async getDeck(roomId): Promise<string[]> {
      return publicClient.readContract({
        address: diamond,
        abi: PREGAME_ABI,
        functionName: "getDeck",
        args: [roomId],
      }) as Promise<string[]>;
    },

    async isAgent(roomId, addr) {
      return publicClient.readContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "isAgent",
        args: [roomId, addr],
      }) as Promise<boolean>;
    },

    async sendStartGame(host, roomId, gasPriceGwei) {
      const hash = await walletFor(host).writeContract({
        address: diamond,
        abi: PREGAME_ABI,
        functionName: "startGame",
        args: [roomId],
        gas: GAS.startGame,
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "startGame");
      return hash;
    },

    async sendCommitDeck(agent, roomId, deckHash, gasPriceGwei) {
      const hash = await walletFor(agent).writeContract({
        address: diamond,
        abi: PREGAME_ABI,
        functionName: "commitDeck",
        args: [roomId, deckHash],
        gas: GAS.commitDeck,
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "commitDeck");
      return hash;
    },

    async sendRevealDeck(agent, roomId, deck, salt, gasPriceGwei) {
      const hash = await walletFor(agent).writeContract({
        address: diamond,
        abi: PREGAME_ABI,
        functionName: "revealDeck",
        args: [roomId, deck, salt],
        gas: GAS.revealDeck,
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "revealDeck");
      return hash;
    },

    async sendShareKeys(agent, roomId, recipients, encryptedKeys, gasPriceGwei) {
      const hash = await walletFor(agent).writeContract({
        address: diamond,
        abi: PREGAME_ABI,
        functionName: "shareKeysToAll",
        args: [roomId, recipients, encryptedKeys],
        gas: GAS.shareKeysToAll,
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "shareKeysToAll");
      return hash;
    },

    async sendCommitAndConfirmRole(agent, roomId, roleHash, gasPriceGwei) {
      const hash = await walletFor(agent).writeContract({
        address: diamond,
        abi: PREGAME_ABI,
        functionName: "commitAndConfirmRole",
        args: [roomId, roleHash],
        gas: GAS.commitAndConfirmRole, // last confirm advances to DAY — heavy
        gasPrice: parseGwei(String(gasPriceGwei)),
      });
      await waitForReceiptOrRevert(publicClient, hash, "commitAndConfirmRole");
      return hash;
    },
  };
}

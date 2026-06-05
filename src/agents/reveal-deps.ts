/**
 * agents/reveal-deps.ts — Real wiring for the post-game reveal driver.
 *
 * Supplies `RevealDeps` (chain reads via getLogs, Redis trace fetch, GM-only
 * reveal send) to the pure `revealRoomTraces` core. Kept thin and free of game
 * logic; exercised by the live smoke rather than unit tests.
 */
import type { Redis } from "ioredis";
import { getAbiItem, type Address, type Hex } from "viem";
import { getChainConfig } from "../chain.js";
import { AGENT_REGISTRY_ABI, DIAMOND_VOTE_ABI } from "./registry-abi.js";
import { agentTraceKey, agentRevealDoneKey, IDEMPOTENCY_TTL_SECONDS } from "./redis-keys.js";
import type { RevealDeps, TraceBlob } from "./reveal-trace.js";

const COMMITTED_EVENT = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: "AgentInferenceCommitted" });
const REVEALED_EVENT = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: "AgentInferenceRevealed" });

/** Scan logs back ~30k blocks in 900-block chunks (matches AgentReport.tsx). */
async function getLogsChunked(publicClient: any, address: Hex, event: any, roomId: bigint, lookback: bigint) {
  const latest: bigint = await publicClient.getBlockNumber();
  const out: any[] = [];
  for (let offset = 0n; offset < lookback; offset += 900n) {
    const toBlock = latest > offset ? latest - offset : 0n;
    const fromBlock = toBlock > 900n ? toBlock - 900n : 0n;
    const chunk = await publicClient.getLogs({ address, event, args: { roomId }, fromBlock, toBlock });
    out.push(...chunk);
    if (toBlock === 0n) break;
  }
  return out;
}

export function buildRevealDeps(
  chainId: number,
  roomId: string,
  redis: Redis,
  lookbackBlocks?: number
): RevealDeps {
  const { public: publicClient, wallet: gmWallet, diamond } = getChainConfig(chainId);
  // How far back from `latest` to scan for this room's commit/reveal logs.
  // Auto-trigger fires on ENDED (recent → default is ample); manual reveals of
  // older same-day games override via the endpoint's `lookbackBlocks`.
  const lookback = BigInt(lookbackBlocks ?? Number(process.env.REVEAL_LOOKBACK_BLOCKS ?? 60000));

  return {
    async getRoom(roomIdBig) {
      const r: any = await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "getRoom",
        args: [roomIdBig],
      });
      return { phase: Number(r.phase), dayCount: Number(r.dayCount) };
    },

    async getCommittedSlots(roomIdBig) {
      const logs = await getLogsChunked(publicClient, diamond, COMMITTED_EVENT, roomIdBig, lookback);
      return logs.map((l: any) => ({
        phaseIdHex: l.args.phaseId as Hex,
        agent: l.args.agent as Address,
        actionHash: l.args.actionHash as Hex,
      }));
    },

    async getRevealedKeys(roomIdBig) {
      const logs = await getLogsChunked(publicClient, diamond, REVEALED_EVENT, roomIdBig, lookback);
      return new Set(
        logs.map(
          (l: any) =>
            `${String(l.args.agent).toLowerCase()}:${String(l.args.phaseId).toLowerCase()}:${String(l.args.actionHash).toLowerCase()}`
        )
      );
    },

    async getTrace(label, agent) {
      const raw = await redis.get(agentTraceKey(chainId, roomId, label, agent));
      return raw ? (JSON.parse(raw) as TraceBlob) : null;
    },

    async claimRevealRun() {
      const res = await redis.set(
        agentRevealDoneKey(chainId, roomId),
        "1",
        "EX",
        IDEMPOTENCY_TTL_SECONDS,
        "NX"
      );
      return res === "OK";
    },

    async sendReveal(s) {
      const hash: Hex = await (gmWallet as any).writeContract({
        address: diamond,
        abi: AGENT_REGISTRY_ABI,
        functionName: "revealAgentInferenceTrace",
        args: [s.roomId, s.phaseIdHex, s.agent, s.somniaRequestId, s.promptHash, s.responseHash, s.actionHash, s.salt],
        gas: 2_000_000n, // light tx: keccak + event; mirrors GAS.commitInference
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`revealAgentInferenceTrace reverted (${hash})`);
      }
      return hash;
    },
  };
}

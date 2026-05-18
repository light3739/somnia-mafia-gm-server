/**
 * agents/ledger.ts — Event-pinned ledger for DAY chat.
 *
 * v1 (4d) populates only the chain-derived fields (votes, kills, deaths).
 * The reserved fields (accusations / claims / defenses) are deliberately
 * present so the Days 8-9 Memory Engine can write into the same schema
 * without a version bump. See [[4d-day-chat-spec]] section 2.
 *
 * Concurrency note: DAY handler runs sequentially per room, so plain
 * GET-mutate-SET is safe for v1. Multi-instance prod must move to
 * Redis WATCH/MULTI or a Lua script.
 */
import type { Redis } from "ioredis";
import type { Address, Hex } from "viem";
import { agentLedgerKey, DAY_CHAT_TTL_SECONDS } from "./redis-keys.js";

export type VoteEntry = { day: number; from: Address; to: Address; txHash: Hex; logIndex: number };
export type KillEntry = { day: number; victim: Address };
export type DeathEntry = { day: number; player: Address; cause: "night-kill" | "day-vote" };
export type AccusationEntry = { day: number; by: Address; target: Address };
export type ClaimEntry = { day: number; by: Address; role: string };
export type DefenseEntry = { day: number; by: Address; defended: Address };

export type Ledger = {
  votes: VoteEntry[];
  kills: KillEntry[];
  deaths: DeathEntry[];
  accusations: AccusationEntry[];
  claims: ClaimEntry[];
  defenses: DefenseEntry[];
};

function emptyLedger(): Ledger {
  return { votes: [], kills: [], deaths: [], accusations: [], claims: [], defenses: [] };
}

export async function loadLedger(
  redis: Redis,
  chainId: number,
  roomId: string
): Promise<Ledger> {
  const raw = await redis.get(agentLedgerKey(chainId, roomId));
  if (!raw) return emptyLedger();
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    return { ...emptyLedger(), ...parsed };
  } catch {
    return emptyLedger();
  }
}

async function saveLedger(
  redis: Redis,
  chainId: number,
  roomId: string,
  led: Ledger
): Promise<void> {
  await redis.set(
    agentLedgerKey(chainId, roomId),
    JSON.stringify(led),
    "EX",
    DAY_CHAT_TTL_SECONDS
  );
}

export async function appendVote(
  redis: Redis, chainId: number, roomId: string, entry: VoteEntry
): Promise<void> {
  const led = await loadLedger(redis, chainId, roomId);
  led.votes.push(entry);
  await saveLedger(redis, chainId, roomId, led);
}

export async function appendKill(
  redis: Redis, chainId: number, roomId: string, entry: KillEntry
): Promise<void> {
  const led = await loadLedger(redis, chainId, roomId);
  led.kills.push(entry);
  await saveLedger(redis, chainId, roomId, led);
}

export async function appendDeath(
  redis: Redis, chainId: number, roomId: string, entry: DeathEntry
): Promise<void> {
  const led = await loadLedger(redis, chainId, roomId);
  led.deaths.push(entry);
  await saveLedger(redis, chainId, roomId, led);
}

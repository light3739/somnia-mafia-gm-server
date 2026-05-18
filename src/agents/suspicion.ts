/**
 * agents/suspicion.ts — Per-agent suspicion/trust vector with eventId
 * idempotency. v1 (4d) is driven only by chain-derived events; the
 * Memory Engine (Days 8-9) will add chat-derived events later.
 */
import type { Redis } from "ioredis";
import type { Address } from "viem";
import {
  agentSuspicionKey,
  agentSuspicionProcessedKey,
  DAY_CHAT_TTL_SECONDS,
} from "./redis-keys.js";

export type SuspicionState = {
  suspicion: Record<string, number>;
  trust: Record<string, number>;
  notes: string[];
};

function emptyState(): SuspicionState {
  return { suspicion: {}, trust: {}, notes: [] };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function bump(map: Record<string, number>, key: Address, delta: number): void {
  const k = key.toLowerCase();
  map[k] = clamp01((map[k] ?? 0) + delta);
}

function pushNote(state: SuspicionState, note: string): void {
  state.notes.push(note);
  if (state.notes.length > 20) state.notes = state.notes.slice(-20);
}

export async function loadSuspicion(
  redis: Redis, chainId: number, roomId: string, agent: Address
): Promise<SuspicionState> {
  const raw = await redis.get(agentSuspicionKey(chainId, roomId, agent));
  if (!raw) return emptyState();
  try { return { ...emptyState(), ...JSON.parse(raw) }; }
  catch { return emptyState(); }
}

async function saveSuspicion(
  redis: Redis, chainId: number, roomId: string, agent: Address, s: SuspicionState
): Promise<void> {
  await redis.set(
    agentSuspicionKey(chainId, roomId, agent),
    JSON.stringify(s),
    "EX",
    DAY_CHAT_TTL_SECONDS
  );
}

async function claimEventId(
  redis: Redis, chainId: number, roomId: string, agent: Address, eventId: string
): Promise<boolean> {
  const key = agentSuspicionProcessedKey(chainId, roomId, agent);
  const added = await redis.sadd(key, eventId);
  if (added === 1) await redis.expire(key, DAY_CHAT_TTL_SECONDS);
  return added === 1;
}

export type VoteEvent = { eventId: string; day: number; from: Address; to: Address };
export type KillEvent = { eventId: string; day: number; victim: Address };

export async function applyVoteEvent(
  redis: Redis, chainId: number, roomId: string, agent: Address, ev: VoteEvent
): Promise<SuspicionState> {
  if (!(await claimEventId(redis, chainId, roomId, agent, ev.eventId))) {
    return loadSuspicion(redis, chainId, roomId, agent);
  }
  const s = await loadSuspicion(redis, chainId, roomId, agent);
  const me = agent.toLowerCase();
  const target = ev.to.toLowerCase();
  if (target === me) {
    bump(s.suspicion, ev.from, 0.15);
    pushNote(s, `Day ${ev.day}: ${ev.from.toLowerCase()} voted against me`);
  } else {
    bump(s.suspicion, ev.from, 0.02);
    pushNote(s, `Day ${ev.day}: ${ev.from.toLowerCase()} voted for ${target}`);
  }
  await saveSuspicion(redis, chainId, roomId, agent, s);
  return s;
}

export async function applyKillEvent(
  redis: Redis, chainId: number, roomId: string, agent: Address, ev: KillEvent
): Promise<SuspicionState> {
  if (!(await claimEventId(redis, chainId, roomId, agent, ev.eventId))) {
    return loadSuspicion(redis, chainId, roomId, agent);
  }
  const s = await loadSuspicion(redis, chainId, roomId, agent);
  pushNote(s, `Day ${ev.day}: night kill — victim ${ev.victim.toLowerCase()}`);
  await saveSuspicion(redis, chainId, roomId, agent, s);
  return s;
}

/**
 * agents/redis-keys.ts — Centralised Redis key schema for the agent subsystem.
 *
 * Two distinct idempotency surfaces:
 *
 *   1. Event-level   — one Diamond log can be re-delivered after a WS reconnect
 *                      or backfill replay. Keyed by (chainId, txHash, logIndex).
 *                      Owned by 4a.
 *
 *   2. Action-level  — one agent must not be invoked twice for the same phase
 *                      slot (otherwise: two vote tx, two night actions). Keyed
 *                      by (chainId, roomId, phaseId, agent, actionType). Owned
 *                      by 4b onward.
 *
 * Also exposes a per-chain "last processed block" cursor so the listener can
 * backfill events missed during downtime.
 */
import type { Hex } from "viem";

const NS = "agents";

export function eventProcessedKey(
  chainId: number,
  txHash: Hex,
  logIndex: number
): string {
  return `${NS}:event:${chainId}:${txHash.toLowerCase()}:${logIndex}`;
}

export function agentActionProcessedKey(
  chainId: number,
  roomId: string,
  phaseId: string,
  agent: Hex,
  actionType: string
): string {
  return `${NS}:action:${chainId}:${roomId}:${phaseId}:${agent.toLowerCase()}:${actionType}`;
}

export function lastBlockKey(chainId: number, diamond: Hex): string {
  return `${NS}:lastBlock:${chainId}:${diamond.toLowerCase()}`;
}

/** TTL for idempotency markers — long enough to outlive any reasonable game
 * but short enough that Redis doesn't accumulate forever. 7 days. */
export const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

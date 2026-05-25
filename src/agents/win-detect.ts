/**
 * agents/win-detect.ts
 *
 * Shared win-detection logic extracted from the /win-check HTTP handler.
 * Used by both the poll endpoint and the headless ZK endgame finalizer
 * so they can never disagree.
 */
import { FLAGS, Role } from '../types/contract.js';
import type { Player } from '../types/contract.js';
import type { GMStore } from '../stores/index.js';
import { logger } from '../utils/logger.js';

export type Winner = "MAFIA" | "TOWN" | null;

export interface WinnerResult {
  winner: Winner;
  mafiaCount: number;
  townCount: number;
}

/**
 * Pure function: count alive mafia vs town from a player list + roles map.
 * Mirrors the counting block in /win-check exactly.
 *   - Alive = FLAGS.ACTIVE bit set in player.flags
 *   - Wallet key in roles map must be lowercase
 *   - mafiaCount === 0 → "TOWN"
 *   - mafiaCount > 0 && mafiaCount >= townCount → "MAFIA"
 *   - else → null (game ongoing)
 */
export function computeWinner(
  players: readonly Player[],
  roles: Map<string, Role>,
): WinnerResult {
  let mafiaCount = 0;
  let townCount = 0;

  for (const p of players) {
    if (Number(p.flags) & FLAGS.ACTIVE) {
      const r = roles.get(p.wallet.toLowerCase());
      if (r === Role.MAFIA) mafiaCount++;
      else if (r !== undefined && r !== Role.NONE) townCount++;
    }
  }

  if (mafiaCount === 0) {
    return { winner: "TOWN", mafiaCount, townCount };
  }
  if (mafiaCount >= townCount) {
    return { winner: "MAFIA", mafiaCount, townCount };
  }
  return { winner: null, mafiaCount, townCount };
}

export interface DetectWinnerArgs {
  roomId: string;
  chainId: number;
  store: GMStore;
  players: readonly Player[];
  phase: number;
}

export interface ResolveRolesArgs {
  roomId: string;
  chainId: number;
  store: GMStore;
  phase: number;
}

/**
 * Resolves roles for a room: memory lookup first, then Redis fallback.
 * Mirrors the role-restore block in /win-check (~lines 84-113).
 * Returns an empty Map when no roles are found anywhere.
 */
export async function resolveRolesWithFallback(args: ResolveRolesArgs): Promise<Map<string, Role>> {
  const { roomId, chainId, store, phase } = args;
  const roomKey = store.getRoomKey(chainId, roomId);

  let roles = store.resolvedRoles.get(roomKey);

  // Fallback: restore roles from Redis if memory is empty (mirrors winRoutes.ts)
  if ((!roles || roles.size === 0) && (phase >= 3 && phase <= 5)) {
    try {
      const { getRedis } = await import('../redis.js');
      const redis = getRedis();
      if (redis) {
        const pattern = `gm:room:${chainId}:${roomId}:role:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          const vals = await redis.mget(keys);
          const restoredRoles = new Map<string, Role>();
          for (let i = 0; i < keys.length; i++) {
            if (vals[i]) {
              const addr = keys[i].split(':')[5];
              restoredRoles.set(addr, Number(vals[i]) as Role);
            }
          }
          if (restoredRoles.size > 0) {
            store.resolvedRoles.set(roomKey, restoredRoles);
            roles = restoredRoles;
            logger.info({ roomId, count: restoredRoles.size }, '[win-detect] Restored roles from Redis');
          }
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message, roomId }, '[win-detect] Failed to fallback read roles from Redis');
    }
  }

  return roles ?? new Map();
}

/**
 * Async wrapper: resolves roles (memory → Redis fallback) then calls computeWinner.
 * Mirrors the role-restore block in /win-check (~lines 84-113).
 * Returns { winner: null, mafiaCount: 0, townCount: 0 } when roles are unknown.
 */
export async function detectWinner(args: DetectWinnerArgs): Promise<WinnerResult> {
  const { roomId, chainId, store, players, phase } = args;

  const roles = await resolveRolesWithFallback({ roomId, chainId, store, phase });

  if (!roles || roles.size === 0) {
    return { winner: null, mafiaCount: 0, townCount: 0 };
  }

  return computeWinner(players, roles);
}

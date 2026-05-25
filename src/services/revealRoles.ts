/**
 * services/revealRoles.ts — Reusable GM helper for revealing player roles on-chain.
 *
 * Extracted from winRoutes.ts `/reveal-roles` handler so both the HTTP route
 * and the headless-endgame finalizer can share the same logic without duplication.
 */
import { getRoom, getPlayers, revealRolesOnChain } from "../chain.js";
import { ServerStore } from "./serverStore.js";
import type { GMStore } from "../stores/index.js";
import type { Address, Hex } from "viem";
import { logger } from "../utils/logger.js";
import { wsManager } from "../ws/wsManager.js";

export type RevealResult =
  | { hash: `0x${string}` }
  | { skipped: true; reason: string };

/**
 * Reveal player roles on-chain for a given room.
 *
 * Returns `{ hash }` on success.
 * Returns `{ skipped, reason }` (does NOT throw) when:
 *   - the room is not in ENDED phase (phase !== 6), or
 *   - any player's role secret is missing.
 *
 * Callers that need throw-on-skip semantics should wrap accordingly.
 */
export async function revealRoomRoles(
  roomId: bigint,
  chainId: number,
  store: GMStore
): Promise<RevealResult> {
  const roomIdStr = String(roomId);

  const [secrets, players, room] = await Promise.all([
    ServerStore.getRoomSecrets(roomIdStr, chainId),
    getPlayers(roomId, chainId),
    getRoom(roomId, chainId),
  ]);

  if (room.phase !== 6) {
    return {
      skipped: true,
      reason: `Room not in ENDED phase (current: ${room.phase})`,
    };
  }

  if (!secrets || Object.keys(secrets).length === 0) {
    return { skipped: true, reason: "No secrets found for this room" };
  }

  const playerAddresses: Address[] = [];
  const mappedRoles: number[] = [];
  const salts: Hex[] = [];

  for (const p of players) {
    const addr = p.wallet.toLowerCase();
    const s = secrets[addr];

    playerAddresses.push(p.wallet as Address);

    if (!s) {
      logger.warn(
        { roomId: roomIdStr, player: addr },
        "[revealRoomRoles] No secret found for player"
      );
      return { skipped: true, reason: `No secret found for player ${addr}` };
    }

    // Use real role+salt for ALL players (alive or dead)
    mappedRoles.push(Number(s.role) === 1 ? 1 : 0);
    const cleanSalt = String(s.salt).startsWith("0x")
      ? String(s.salt)
      : "0x" + String(s.salt);
    salts.push(cleanSalt as Hex);
  }

  logger.info(
    { roomId: roomIdStr, playerCount: playerAddresses.length },
    "[revealRoomRoles] Submitting role reveal on-chain..."
  );

  const { hash } = await revealRolesOnChain(
    roomId,
    playerAddresses,
    mappedRoles,
    salts,
    chainId
  );

  logger.info({ roomId: roomIdStr, hash }, "[revealRoomRoles] Roles revealed on-chain");

  // Push revealed roles to all WS clients
  const roomKey = store.getRoomKey(chainId, roomIdStr);
  const cachedRoles = store.resolvedRoles.get(roomKey);
  if (cachedRoles) {
    const roleToString: Record<number, string> = {
      1: "MAFIA",
      2: "DOCTOR",
      3: "DETECTIVE",
      4: "CIVILIAN",
    };
    const revealedRoles: Record<string, string> = {};
    for (const [addr, role] of cachedRoles.entries()) {
      revealedRoles[addr.toLowerCase()] =
        roleToString[role as number] || "UNKNOWN";
    }
    wsManager.broadcastToRoom(roomIdStr, chainId, {
      type: "roles-revealed",
      data: { roles: revealedRoles },
    });
  }

  return { hash };
}

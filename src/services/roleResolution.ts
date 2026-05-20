/**
 * services/roleResolution.ts — shared GM role resolution.
 *
 * Extracted from routes/eciesRoutes.ts so both the human HTTP path
 * (/submit-sra-key) and the headless agent pre-game (4j mixed) accumulate SRA
 * keys in the same GMStore and resolve roles identically. When the union of all
 * players' keys is present, decrypt the on-chain deck (resolveRolesFromDeck),
 * persist + sync, and fire onResolved so the agent subsystem can confirm agent
 * roles without polling.
 */
import type { Redis } from "ioredis";
import type { RedisClient } from "../redis.js";
import type { GMStore } from "../stores/index.js";
import { Role } from "../types/contract.js";
import { resolveRolesFromDeck } from "../agents/role-resolve.js";
import { syncAgentRolesFromResolvedRoles } from "../agents/role-sync.js";
import { wsManager } from "../ws/wsManager.js";
import { logger } from "../utils/logger.js";

export interface ResolveCtx {
  store: GMStore;
  redis: RedisClient;
  chainId: number;
  roomId: string;
  /** Players in on-chain slot order (slot i = element i). */
  fetchPlayers: () => Promise<readonly { wallet: string }[]>;
  /** Final on-chain revealedDeck. */
  fetchDeck: () => Promise<string[]>;
}

type OnResolvedCb = (chainId: number, roomId: string) => void;
const onResolvedCbs: OnResolvedCb[] = [];

/** Subscribe to "all keys present, roles just resolved" for a room. */
export function registerOnResolved(cb: OnResolvedCb): void {
  onResolvedCbs.push(cb);
}

/** Test helper — clear subscribers between tests. */
export function _resetOnResolvedForTests(): void {
  onResolvedCbs.length = 0;
}

/** Store one player's SRA decryption key, then try to resolve the room. */
export async function submitSraKey(
  ctx: ResolveCtx,
  address: string,
  sraKey: string
): Promise<void> {
  const roomKey = ctx.store.getRoomKey(ctx.chainId, ctx.roomId);
  const addr = address.toLowerCase();
  ctx.store.getRoomMap(ctx.store.sraSKeys, roomKey).set(addr, sraKey);
  if (ctx.redis) {
    const { rPersistSraKey, rPersistRoomChain } = await import("../redis.js");
    rPersistSraKey(ctx.redis, ctx.chainId, ctx.roomId, addr, sraKey);
    rPersistRoomChain(ctx.redis, ctx.chainId, ctx.roomId);
  }
  await maybeResolveRoles(ctx);
}

/** Resolve roles iff every player's key is present. Idempotent; fires onResolved once. */
export async function maybeResolveRoles(ctx: ResolveCtx): Promise<void> {
  const roomKey = ctx.store.getRoomKey(ctx.chainId, ctx.roomId);

  // Fast-path: already resolved before any awaits.
  const existing = ctx.store.resolvedRoles.get(roomKey);
  if (existing && existing.size > 0) return;

  // --- async pre-checks (window where concurrency can slip through) ---
  const roomSra = ctx.store.getRoomMap(ctx.store.sraSKeys, roomKey);
  const players = await ctx.fetchPlayers();
  const addrs = players.map((p) => p.wallet.toLowerCase());
  if (addrs.length === 0 || !addrs.every((a) => roomSra.has(a))) return;

  const deck = await ctx.fetchDeck();
  if (deck.length === 0) return;

  // --- synchronous critical section: re-check + claim atomically ---
  // A concurrent caller may have resolved while we were awaiting above.
  // getRoomMap ensures the nested Map exists; if it already has entries,
  // this invocation lost the race and must bail.
  const roomRoles = ctx.store.getRoomMap(ctx.store.resolvedRoles, roomKey);
  if (roomRoles.size > 0) return; // lost the race — bail before any side-effects

  const order = (ctx.store.roomPlayerOrder.get(roomKey) as string[] | undefined) || addrs;
  const allKeys = addrs.map((a) => roomSra.get(a)!).filter(Boolean) as string[];
  const resolved = resolveRolesFromDeck(deck, order, allKeys, ctx.roomId);

  // Populate the map synchronously — no await between re-check and this loop,
  // so no concurrent caller can slip past the size>0 guard above.
  for (const [addr, role] of resolved) {
    if (role === Role.NONE) {
      logger.warn({ player: addr, roomId: ctx.roomId }, "[roleResolution] role resolved to NONE");
    }
    roomRoles.set(addr, role);
  }
  // roomRoles is now fully populated; concurrent callers will see size > 0 and bail.

  // --- async side-effects (safe: room is already claimed) ---
  if (ctx.redis) {
    const { rPersistRole } = await import("../redis.js");
    for (const [addr, role] of resolved) {
      rPersistRole(ctx.redis, ctx.chainId, ctx.roomId, addr, role);
    }
  }

  const mafia = [...resolved].filter(([, r]) => r === Role.MAFIA).map(([a]) => a);
  wsManager.setRoomMafia(ctx.roomId, ctx.chainId, mafia);

  if (ctx.redis) {
    // syncAgentRolesFromResolvedRoles requires a non-null Redis instance
    await syncAgentRolesFromResolvedRoles(ctx.redis as Redis, ctx.chainId, ctx.roomId, roomRoles);
  }

  for (const addr of order) {
    wsManager.sendToPlayer(addr, { type: "role-ready", data: { playerAddress: addr.toLowerCase() } });
  }

  logger.info({ roomId: ctx.roomId, chainId: ctx.chainId, count: resolved.size }, "[roleResolution] roles resolved");

  for (const cb of onResolvedCbs) {
    try {
      cb(ctx.chainId, ctx.roomId);
    } catch (err) {
      logger.error({ err }, "[roleResolution] onResolved callback threw");
    }
  }
}

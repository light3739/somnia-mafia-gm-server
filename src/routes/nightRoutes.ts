/**
 * routes/nightRoutes.ts
 */
import { Router } from 'express';
import { type Address } from 'viem';
import {
  getRoom, getPlayers, resolveNight, hasCommittedRole, getChainConfig,
  GM_ADDRESS, FLAGS, GamePhase,
} from '../chain.js';
import {
  getOrCreateNightState, getNightState, clearNightState,
  calculateMafiaConsensus, getDoctorHeal, type NightAction,
} from '../game-state.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 180_000);
const nightTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const nightChainIds = new Map<string, number | undefined>();

function clearNightTimer(roomIdStr: string): void {
  const t = nightTimers.get(roomIdStr);
  if (t) { clearTimeout(t); nightTimers.delete(roomIdStr); }
}

export async function doResolveNight(rid: bigint, store: GMStore, redis: RedisClient, chainId?: number | string): Promise<void> {
  const state = getNightState(rid);
  if (!state || state.resolved) return;
  if (state.actions.size === 0) return;

  state.resolved = true;
  const { rPersistNightState, rDeleteNightState } = await import('../redis.js');
  if (redis) rPersistNightState(redis, String(rid), state);

  const allActions = [...state.actions.values()];

  let totalAliveMafia: number | undefined;
  try {
    const players = await getPlayers(rid, chainId as any) as any[];
    const roomRoles = store.resolvedRoles.get(String(rid));
    if (roomRoles) {
      totalAliveMafia = players.filter((p: any) =>
        !!(Number(p.flags) & FLAGS.ACTIVE) &&
        roomRoles.get(p.wallet.toLowerCase()) === 'MAFIA',
      ).length;
    }
  } catch { /* ... */ }

  const killTarget = calculateMafiaConsensus(allActions, totalAliveMafia);
  const healTarget = getDoctorHeal(allActions);

  try {
    await resolveNight(rid, killTarget, healTarget, chainId as any);
  } catch (err: any) {
    if (getNightState(rid)) {
      getNightState(rid)!.resolved = false;
      if (redis) rPersistNightState(redis, String(rid), getNightState(rid)!); 
    }
    throw err;
  } finally {
    clearNightTimer(String(rid));
    nightChainIds.delete(String(rid));
  }
  clearNightState(rid);
  if (redis) rDeleteNightState(redis, String(rid));
}

export function scheduleNightTimeout(rid: bigint, store: GMStore, redis: RedisClient, chainId?: number | string): void {
  const key = String(rid);
  clearNightTimer(key);
  nightChainIds.set(key, chainId as any);
  const t = setTimeout(async () => {
    nightTimers.delete(key);
    const s = getNightState(rid);
    if (!s || s.resolved) return;
    doResolveNight(rid, store, redis, chainId as any).catch(() => {});
  }, NIGHT_TIMEOUT_MS);
  nightTimers.set(key, t);
}

export interface NightRoutesContext {
  store: GMStore;
  redis: RedisClient;
  verifyAuthorizedSignature: any;
  actionLimiter: RateLimitRequestHandler;
  pollLimiter: RateLimitRequestHandler;
  heavyLimiter: RateLimitRequestHandler;
}

export function createNightRoutes(ctx: NightRoutesContext) {
  const router = Router();
  const { store, redis, verifyAuthorizedSignature, actionLimiter, pollLimiter, heavyLimiter } = ctx;

  const allRolePlayersActed = (roomIdStr: string, alivePlayers: any[]) => {
    const roles = store.resolvedRoles.get(roomIdStr);
    if (!roles) return false;
    const roleActors = alivePlayers.filter((p: any) => {
      const r = roles.get(p.wallet.toLowerCase());
      return r && r !== 'CIVILIAN';
    });
    if (roleActors.length === 0) return false;
    const state = getNightState(BigInt(roomIdStr));
    return state && roleActors.every((p: any) => state.actions.has(p.wallet.toLowerCase()));
  };

  router.post('/night-action', actionLimiter, async (req, res) => {
    try {
      const {
        roomId, playerAddress, actionType, targetAddress,
        signature, signerAddress, nonce, timestamp, chainId, dayCount,
      } = req.body;

      if (!roomId || !playerAddress || !actionType || !targetAddress || !signature) {
        return res.status(400).json({ error: 'Missing req fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress, signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `night:${roomId}:${actionType}:${String(targetAddress).toLowerCase()}`,
        buildModernMessage: (n: string, ts: number) => `night:${roomId}:${dayCount || 0}:${actionType}:${String(targetAddress).toLowerCase()}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const rid = BigInt(roomId);
      const room: any = await getRoom(rid, chainId);
      if (Number(room.phase) !== GamePhase.NIGHT) return res.status(400).json({ error: 'Not NIGHT phase' });

      const players = await getPlayers(rid, chainId);
      const player = players.find((p: any) => p.wallet.toLowerCase() === String(playerAddress).toLowerCase());
      if (!player || !(Number(player.flags) & FLAGS.ACTIVE)) return res.status(400).json({ error: 'Dead/Not in room' });

      const committed = await hasCommittedRole(rid, playerAddress as Address, chainId);
      if (!committed) return res.status(403).json({ error: 'No on-chain role' });

      const roomRoles = store.resolvedRoles.get(String(roomId));
      const playerRole = roomRoles?.get(String(playerAddress).toLowerCase());
      if (playerRole) {
        const required = { kill: 'MAFIA', heal: 'DOCTOR', check: 'DETECTIVE' }[actionType as 'kill' | 'heal' | 'check'];
        if (required && playerRole !== required) return res.status(403).json({ error: `Requires ${required}` });
      }

      const state = getOrCreateNightState(rid);
      if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

      state.actions.set(String(playerAddress).toLowerCase(), {
        playerAddress: playerAddress as Address, actionType,
        targetAddress: targetAddress as Address, timestamp: Date.now(),
      });
      
      const { rPersistNightState } = await import('../redis.js');
      if (redis) rPersistNightState(redis, String(roomId), state);

      if (actionType === 'check') {
        store.getRoomMap(store.investigationProofs, String(roomId)).set(String(playerAddress).toLowerCase(), {
          targetAddress: String(targetAddress), timestamp: Date.now(),
        });
      }

      const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
      if (allRolePlayersActed(String(roomId), alivePlayers)) {
        doResolveNight(rid, store, redis, chainId).catch(() => {});
      } else if (state.actions.size === 1) {
        scheduleNightTimeout(rid, store, redis, chainId);
      }

      return res.json({ ok: true, actionsReceived: state.actions.size });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/resolve-night', heavyLimiter, async (req, res) => {
    try {
      const { roomId, signature, callerAddress, playerAddress: reqPlayerAddress, signerAddress, nonce, timestamp, chainId } = req.body;
      const mainWallet = reqPlayerAddress || callerAddress;
      const effectiveSigner = signerAddress || (reqPlayerAddress ? callerAddress : undefined);

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(mainWallet), signerAddress: effectiveSigner,
        nonce, timestamp, chainId,
        buildLegacyMessage: () => `resolve-night:${roomId}`,
        buildModernMessage: (n: string, ts: number) => `resolve-night:${roomId}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const rid = BigInt(roomId);
      const room: any = await getRoom(rid, chainId);
      const host = (room.host || '').toLowerCase();
      const isHostOrGM = String(mainWallet).toLowerCase() === host || sigCheck.signer === host || String(mainWallet).toLowerCase() === GM_ADDRESS.toLowerCase();
      
      if (!isHostOrGM && !(Number(room.phaseDeadline) > 0 && Math.floor(Date.now() / 1000) > Number(room.phaseDeadline) + 30)) {
        return res.status(403).json({ error: 'Unauthorized manual resolve' });
      }

      await doResolveNight(rid, store, redis, chainId);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/night-status/:roomId', pollLimiter, (req, res) => {
    const state = getNightState(BigInt(req.params.roomId));
    if (!state) return res.json({ active: false, actionsReceived: 0 });
    return res.json({ active: true, actionsReceived: state.actions.size, resolved: state.resolved });
  });

  return router;
}

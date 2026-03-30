/**
 * routes/nightRoutes.ts
 */
import { Router } from 'express';
import { type Address } from 'viem';
import {
  getRoom, getPlayers, resolveNight, hasCommittedRole,
  GM_ADDRESS, FLAGS, GamePhase,
} from '../chain.js';
import { Role } from '../types/contract.js';
import {
  getOrCreateNightState, getNightState, clearNightState,
  calculateMafiaConsensus, getDoctorHeal, type NightAction,
} from '../game-state.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 180_000);
const nightTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const nightChainIds = new Map<string, number | undefined>();

function clearNightTimer(roomKey: string): void {
  const t = nightTimers.get(roomKey);
  if (t) { clearTimeout(t); nightTimers.delete(roomKey); }
}

export async function doResolveNight(rid: bigint, store: GMStore, redis: RedisClient, chainId?: number | string): Promise<void> {
  const state = getNightState(rid);
  if (!state || state.resolved) return;
  const effectiveChainId = Number(chainId || state.chainId);
  if (state.actions.size === 0) return;

  state.resolved = true;
  const roomKey = store.getRoomKey(effectiveChainId, String(rid));
  const { rPersistNightState, rDeleteNightState } = await import('../redis.js');
  if (redis) rPersistNightState(redis, effectiveChainId, String(rid), state);

  const allActions = [...state.actions.values()];

  let totalAliveMafia: number | undefined;
  try {
    const players = await getPlayers(rid, effectiveChainId);
    const roomRoles = store.resolvedRoles.get(roomKey);
    if (roomRoles) {
      totalAliveMafia = players.filter((p) =>
        !!(Number(p.flags) & FLAGS.ACTIVE) &&
        roomRoles.get(p.wallet.toLowerCase()) === Role.MAFIA,
      ).length;
    }
  } catch { /* ... */ }

  const killTarget = calculateMafiaConsensus(allActions, totalAliveMafia);
  const healTarget = getDoctorHeal(allActions);

  try {
    await resolveNight(rid, killTarget, healTarget, effectiveChainId);
  } catch (err: any) {
    if (getNightState(rid)) {
      getNightState(rid)!.resolved = false;
      if (redis) rPersistNightState(redis, effectiveChainId, String(rid), getNightState(rid)!);
    }
    throw err;
  } finally {
    clearNightTimer(roomKey);
    nightChainIds.delete(roomKey);
  }
  clearNightState(rid);
  if (redis) rDeleteNightState(redis, effectiveChainId, String(rid));
}

export function scheduleNightTimeout(rid: bigint, store: GMStore, redis: RedisClient, chainId?: number | string): void {
  const roomKey = store.getRoomKey(Number(chainId || 43113), String(rid));
  clearNightTimer(roomKey);
  nightChainIds.set(roomKey, Number(chainId));
  const t = setTimeout(async () => {
    nightTimers.delete(roomKey);
    const s = getNightState(rid);
    if (!s || s.resolved) return;
    doResolveNight(rid, store, redis, chainId).catch(() => {});
  }, NIGHT_TIMEOUT_MS);
  nightTimers.set(roomKey, t);
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

  const allRolePlayersActed = (chainId: number, roomIdStr: string, alivePlayers: ReturnType<typeof Array.prototype.filter>) => {
    const roomKey = store.getRoomKey(chainId, roomIdStr);
    const roles = store.resolvedRoles.get(roomKey);
    if (!roles) return false;
    const roleActors = alivePlayers.filter((p) => {
      const r = roles.get(p.wallet.toLowerCase());
      return r !== undefined && r !== Role.CITIZEN && r !== Role.NONE;
    });
    if (roleActors.length === 0) return false;
    const state = getNightState(BigInt(roomIdStr));
    return state && roleActors.every((p) => state.actions.has(p.wallet.toLowerCase()));
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
        buildLegacyMessage: () => new SignatureBuilder('night', chainId, roomId).withParam(actionType).withAddress(targetAddress).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('night', chainId, roomId).withParam(dayCount || 0).withParam(actionType).withAddress(targetAddress).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const rid = BigInt(roomId);
      const room = await getRoom(rid, chainId);
      if (Number(room.phase) !== GamePhase.NIGHT) return res.status(400).json({ error: 'Not NIGHT phase' });

      const players = await getPlayers(rid, chainId);
      const player = players.find((p) => p.wallet.toLowerCase() === String(playerAddress).toLowerCase());
      if (!player || !(Number(player.flags) & FLAGS.ACTIVE)) return res.status(400).json({ error: 'Dead/Not in room' });

      const committed = await hasCommittedRole(rid, playerAddress as Address, chainId);
      if (!committed) return res.status(403).json({ error: 'No on-chain role' });

      const roomKey = store.getRoomKey(Number(chainId), String(roomId));
      const roomRoles = store.resolvedRoles.get(roomKey);
      const playerRole = roomRoles?.get(String(playerAddress).toLowerCase());
      if (playerRole !== undefined) {
        const required: Record<string, Role> = { kill: Role.MAFIA, heal: Role.DOCTOR, check: Role.DETECTIVE };
        const reqRole = required[actionType as string];
        if (reqRole !== undefined && playerRole !== reqRole) return res.status(403).json({ error: `Requires role ${reqRole}` });
      }

      const state = getOrCreateNightState(rid, Number(chainId));
      if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

      state.actions.set(String(playerAddress).toLowerCase(), {
        playerAddress: playerAddress as Address, actionType: actionType as any,
        targetAddress: targetAddress as Address, timestamp: Date.now(),
      });
      
      const { rPersistNightState } = await import('../redis.js');
      if (redis) rPersistNightState(redis, Number(chainId), String(roomId), state);

      if (actionType === 'check') {
        store.getRoomMap(store.investigationProofs, roomKey).set(String(playerAddress).toLowerCase(), {
          targetAddress: targetAddress as Address, timestamp: Date.now(),
        });
      }

      const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
      if (allRolePlayersActed(Number(chainId), String(roomId), alivePlayers)) {
        doResolveNight(rid, store, redis, chainId).catch(() => {});
      } else if (state.actions.size === 1) {
        scheduleNightTimeout(rid, store, redis, chainId);
      }

      return res.json({ ok: true, actionsReceived: state.actions.size });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/skip-night-action', actionLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, signature, signerAddress, nonce, timestamp, chainId, dayCount } = req.body;
      if (!roomId || !playerAddress || !signature) return res.status(400).json({ error: 'Missing req fields' });

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress, signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('skip-night', chainId, roomId).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('skip-night', chainId, roomId).withParam(dayCount || 0).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const rid = BigInt(roomId);
      const players = await getPlayers(rid, chainId);
      const player = players.find((p) => p.wallet.toLowerCase() === String(playerAddress).toLowerCase());
      if (!player || !(Number(player.flags) & FLAGS.ACTIVE)) return res.status(400).json({ error: 'Dead/Not in room' });

      const state = getOrCreateNightState(rid, Number(chainId));
      if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

      // Mark as skipped (no actionType or targetAddress)
      state.actions.set(String(playerAddress).toLowerCase(), {
        playerAddress: playerAddress as Address, actionType: 'skip',
        targetAddress: playerAddress as Address, timestamp: Date.now(),
      });
      
      const { rPersistNightState } = await import('../redis.js');
      if (redis) rPersistNightState(redis, Number(chainId), String(roomId), state);

      const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
      if (allRolePlayersActed(Number(chainId), String(roomId), alivePlayers)) {
        doResolveNight(rid, store, redis, chainId).catch(() => {});
      } else if (state.actions.size === 1) {
        scheduleNightTimeout(rid, store, redis, chainId);
      }

      return res.json({ ok: true, actionsReceived: state.actions.size });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/investigation-proof', actionLimiter, async (req, res) => {
    try {
      const { roomId, detectiveAddress, targetAddress, dayCount, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(detectiveAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('investigate', chainId, roomId).withAddress(targetAddress).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('investigate', chainId, roomId).withParam(dayCount || 0).withAddress(targetAddress).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const roomKey = store.getRoomKey(Number(chainId), String(roomId));
      const proof = store.investigationProofs.get(roomKey)?.get(String(detectiveAddress).toLowerCase());
      if (!proof || proof.targetAddress.toLowerCase() !== String(targetAddress).toLowerCase()) {
        return res.status(404).json({ error: 'No investigation result found for this target tonight' });
      }

      const roles = store.resolvedRoles.get(roomKey);
      const role = roles?.get(String(targetAddress).toLowerCase()) ?? 4; // default civilian
      return res.json({ ok: true, role, source: 'GM_CACHE' });
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
        buildLegacyMessage: () => new SignatureBuilder('resolve-night', chainId, roomId).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('resolve-night', chainId, roomId).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const rid = BigInt(roomId);
      const room = await getRoom(rid, chainId);
      const host = (room.host as string).toLowerCase();
      const isHostOrGM = String(mainWallet).toLowerCase() === host || sigCheck.signer === host || String(mainWallet).toLowerCase() === GM_ADDRESS.toLowerCase();
      
      if (!isHostOrGM && !(Number(room.phaseDeadline) > 0 && Math.floor(Date.now() / 1000) > Number(room.phaseDeadline) + 2)) {
        return res.status(403).json({ error: 'Unauthorized manual resolve. Wait for deadline + 2s.' });
      }

      await doResolveNight(rid, store, redis, chainId);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/night-status/:roomId', pollLimiter, (req, res) => {
    const rid = BigInt(req.params.roomId);
    const state = getNightState(rid);
    if (!state) return res.json({ active: false, actionsReceived: 0 });
    return res.json({ active: true, actionsReceived: state.actions.size, resolved: state.resolved });
  });

  return router;
}

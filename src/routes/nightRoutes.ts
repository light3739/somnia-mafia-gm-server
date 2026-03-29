/**
 * routes/nightRoutes.ts
 * POST /night-action       — submit mafia/doctor/detective action
 * POST /skip-night-action  — player passes their turn
 * POST /resolve-night      — host/GM resolves night
 * POST /role-commit-sync   — notify GM of committed role
 * GET  /night-status/:id   — polling: how many actions collected
 * POST /investigation-proof — detective proof verification
 */
import { Router } from 'express';
import { type Address } from 'viem';
import { verifyAuthorizedSignature } from '../auth/verifySignature.js';
import {
  getRoom, getPlayers, resolveNight, hasCommittedRole, getChainConfig,
  getSessionKey, GM_ADDRESS, FLAGS, GamePhase,
} from '../chain.js';
import {
  getOrCreateNightState, getNightState, clearNightState,
  calculateMafiaConsensus, getDoctorHeal, type NightAction,
} from '../game-state.js';
import { getRedis, rPersistNightState, rDeleteNightState } from '../redis.js';
import {
  resolvedRoles, investigationProofs, getRoomMap,
} from '../stores/index.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

// ─── Night timer state ──────────────────────────────────────
const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 180_000);
const nightTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const nightChainIds = new Map<string, number | undefined>();

function clearNightTimer(roomIdStr: string): void {
  const t = nightTimers.get(roomIdStr);
  if (t) { clearTimeout(t); nightTimers.delete(roomIdStr); }
}

export async function doResolveNight(rid: bigint, chainId?: number): Promise<void> {
  const state = getNightState(rid);
  if (!state || state.resolved) return;
  if (state.actions.size === 0) {
    console.warn(`[auto-resolve] Room ${rid}: no actions submitted — skipping`);
    return;
  }

  state.resolved = true;
  rPersistNightState(getRedis(), String(rid), state);

  const allActions = [...state.actions.values()];

  let totalAliveMafia: number | undefined;
  try {
    const players = await getPlayers(rid, chainId) as any[];
    const roomRoles = resolvedRoles.get(String(rid));
    if (roomRoles) {
      totalAliveMafia = players.filter((p: any) =>
        !!(Number(p.flags) & FLAGS.ACTIVE) &&
        roomRoles.get(p.wallet.toLowerCase()) === 'MAFIA',
      ).length;
    }
  } catch { /* non-fatal */ }

  const killTarget = calculateMafiaConsensus(allActions, totalAliveMafia);
  const healTarget = getDoctorHeal(allActions);

  console.log(`[auto-resolve] Room ${rid}: kill=${killTarget}, heal=${healTarget}`);
  try {
    const { hash } = await resolveNight(rid, killTarget, healTarget, chainId);
    console.log(`[auto-resolve] Room ${rid}: tx ${hash}`);
  } catch (err: any) {
    const s = getNightState(rid);
    if (s) { s.resolved = false; rPersistNightState(getRedis(), String(rid), s); }
    throw err;
  } finally {
    clearNightTimer(String(rid));
    nightChainIds.delete(String(rid));
  }
  clearNightState(rid);
  rDeleteNightState(getRedis(), String(rid));
}

export function scheduleNightTimeout(rid: bigint, chainId?: number): void {
  const key = String(rid);
  clearNightTimer(key);
  nightChainIds.set(key, chainId);
  const t = setTimeout(async () => {
    nightTimers.delete(key);
    const s = getNightState(rid);
    if (!s || s.resolved) return;
    console.log(`[night-timeout] Room ${rid}: ${NIGHT_TIMEOUT_MS / 1000}s timeout — auto-resolving`);
    doResolveNight(rid, chainId).catch((e: any) =>
      console.error(`[night-timeout] Room ${rid}: auto-resolve failed: ${e.message}`),
    );
  }, NIGHT_TIMEOUT_MS);
  nightTimers.set(key, t);
}

function allRolePlayersActed(roomIdStr: string, alivePlayers: any[]): boolean {
  const roles = resolvedRoles.get(roomIdStr);
  if (!roles) return false;
  const roleActors = alivePlayers.filter((p: any) => {
    const r = roles.get(p.wallet.toLowerCase());
    return r && r !== 'CIVILIAN';
  });
  if (roleActors.length === 0) return false;
  const state = getNightState(BigInt(roomIdStr));
  if (!state) return false;
  return roleActors.every((p: any) => state.actions.has(p.wallet.toLowerCase()));
}

function storeInvestigationProof(roomId: bigint, detective: string, target: string) {
  const roomKey = roomId.toString();
  const roomProofs = getRoomMap(investigationProofs as any, roomKey);
  roomProofs.set(detective, { targetAddress: target, timestamp: Date.now() });
}

// ─── Create Router ──────────────────────────────────────────
export function createNightRoutes(
  actionLimiter: RateLimitRequestHandler,
  pollLimiter: RateLimitRequestHandler,
  heavyLimiter: RateLimitRequestHandler,
) {
  const router = Router();

  // ── Submit Night Action ───────────────────────────────────
  router.post('/night-action', actionLimiter, async (req, res) => {
    try {
      const {
        roomId, playerAddress, actionType, targetAddress,
        signature, signerAddress, nonce, timestamp, chainId, dayCount: bodyDayCount,
      } = req.body;

      if (!roomId || !playerAddress || !actionType || !targetAddress || !signature) {
        return res.status(400).json({ error: 'Missing fields: roomId, playerAddress, actionType, targetAddress, signature' });
      }
      if (!['kill', 'heal', 'check'].includes(actionType)) {
        return res.status(400).json({ error: 'actionType must be: kill, heal, check' });
      }
      if (!nonce || timestamp === undefined) {
        return res.status(400).json({ error: 'nonce and timestamp are required' });
      }

      const rid = BigInt(roomId);
      const room: any = await getRoom(rid, chainId);
      const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
      if (phase !== GamePhase.NIGHT) {
        return res.status(400).json({ error: `Room is not in NIGHT phase (current: ${phase})` });
      }

      const players = await getPlayers(rid, chainId);
      const player = players.find((p: any) => p.wallet.toLowerCase() === String(playerAddress).toLowerCase());
      if (!player) return res.status(400).json({ error: 'Player not in room' });
      if (!(Number(player.flags) & FLAGS.ACTIVE)) return res.status(400).json({ error: 'Player is dead' });

      const target = players.find((p: any) => p.wallet.toLowerCase() === String(targetAddress).toLowerCase());
      if (!target) return res.status(400).json({ error: 'Target not in room' });
      if (actionType === 'kill' && !(Number(target.flags) & FLAGS.ACTIVE)) {
        return res.status(400).json({ error: 'Cannot kill dead player' });
      }
      if (actionType === 'kill' && String(playerAddress).toLowerCase() === String(targetAddress).toLowerCase()) {
        return res.status(400).json({ error: 'Cannot target yourself' });
      }

      const contractDayCount = Array.isArray(room) ? Number(room[7]) : Number(room.dayCount);
      const sigDayCount = bodyDayCount !== undefined ? Number(bodyDayCount) : contractDayCount;
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `night:${roomId}:${actionType}:${String(targetAddress).toLowerCase()}`,
        buildModernMessage: (n, ts) => `night:${roomId}:${sigDayCount}:${actionType}:${String(targetAddress).toLowerCase()}:${n}:${ts}`,
      });

      if (!sigCheck.ok) {
        console.error(`[night-action] Sig FAIL Room:${roomId} err:${sigCheck.error}`);
        return res.status(sigCheck.status).json({ error: sigCheck.error });
      }

      if (Math.abs(contractDayCount - sigDayCount) > 1) {
        return res.status(400).json({ error: `dayCount mismatch: client=${sigDayCount}, contract=${contractDayCount}` });
      }

      const committed = await hasCommittedRole(rid, playerAddress as Address, chainId);
      if (!committed) return res.status(403).json({ error: 'You have not committed a role on-chain' });

      const ACTION_ROLE_MAP: Record<string, string> = { kill: 'MAFIA', heal: 'DOCTOR', check: 'DETECTIVE' };
      const roomRoles = resolvedRoles.get(String(roomId));
      const playerRole = roomRoles?.get(String(playerAddress).toLowerCase());
      if (playerRole) {
        const required = ACTION_ROLE_MAP[actionType];
        if (required && playerRole !== required) {
          return res.status(403).json({ error: `Action '${actionType}' requires ${required} but you are ${playerRole}` });
        }
      }

      const state = getOrCreateNightState(rid);
      if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

      const action: NightAction = {
        playerAddress: playerAddress as Address,
        actionType,
        targetAddress: targetAddress as Address,
        timestamp: Date.now(),
      };
      state.actions.set(String(playerAddress).toLowerCase(), action);
      rPersistNightState(getRedis(), String(roomId), state);

      if (actionType === 'check') {
        storeInvestigationProof(rid, String(playerAddress).toLowerCase(), String(targetAddress).toLowerCase());
      }

      const actionsReceived = state.actions.size;
      console.log(`[night] Room ${roomId}: ${player.nickname} (${actionType}) → ${target.nickname} | ${actionsReceived} actions`);

      const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
      if (allRolePlayersActed(String(roomId), alivePlayers)) {
        console.log(`[night] Room ${roomId}: all role-players acted — auto-resolving`);
        doResolveNight(rid, chainId).catch((e: any) =>
          console.error(`[night] Room ${roomId}: auto-resolve error: ${e.message}`),
        );
      } else if (actionsReceived === 1) {
        scheduleNightTimeout(rid, chainId);
      }

      return res.json({ ok: true, actionsReceived });
    } catch (err: any) {
      console.error('[night-action] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Skip Night Action ─────────────────────────────────────
  router.post('/skip-night-action', actionLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, signature, signerAddress, nonce, timestamp, chainId, dayCount } = req.body;
      if (!roomId || !playerAddress || !signature) {
        return res.status(400).json({ error: 'Missing fields' });
      }

      const rid = BigInt(roomId);
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `skip-night:${roomId}`,
        buildModernMessage: (n, ts) => `skip-night:${roomId}:${dayCount || 0}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const room: any = await getRoom(rid, chainId);
      const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
      if (phase !== GamePhase.NIGHT) {
        return res.status(400).json({ error: 'Room is not in NIGHT phase' });
      }

      const state = getOrCreateNightState(rid);
      if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

      const action: NightAction = {
        playerAddress: playerAddress as Address,
        actionType: 'none' as any,
        targetAddress: '0x0000000000000000000000000000000000000000',
        timestamp: Date.now(),
      };
      state.actions.set(String(playerAddress).toLowerCase(), action);
      rPersistNightState(getRedis(), String(roomId), state);
      console.log(`[night] Room ${roomId}: ${playerAddress} skipped action`);

      const players = await getPlayers(rid, chainId);
      const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
      if (allRolePlayersActed(String(roomId), alivePlayers)) {
        doResolveNight(rid, chainId).catch(e => console.error(`[night] auto-resolve error: ${e.message}`));
      }

      return res.json({ ok: true });
    } catch (err: any) {
      console.error('[skip-night-action] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Resolve Night ─────────────────────────────────────────
  router.post('/resolve-night', heavyLimiter, async (req, res) => {
    try {
      const { roomId, signature, callerAddress, playerAddress: reqPlayerAddress, signerAddress, nonce, timestamp, chainId } = req.body;
      if (!roomId) return res.status(400).json({ error: 'Missing roomId' });
      if (!signature || !callerAddress) {
        return res.status(401).json({ error: 'Missing signature or callerAddress' });
      }

      const mainWallet = reqPlayerAddress || callerAddress;
      const effectiveSigner = signerAddress || (reqPlayerAddress ? callerAddress : undefined);

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(mainWallet), signerAddress: effectiveSigner,
        nonce, timestamp, chainId,
        buildLegacyMessage: () => `resolve-night:${roomId}`,
        buildModernMessage: (n, ts) => `resolve-night:${roomId}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const rid = BigInt(roomId);
      const resolveRoom: any = await getRoom(rid, chainId);
      const resolvePhase = Array.isArray(resolveRoom) ? Number(resolveRoom[3]) : Number(resolveRoom.phase);
      const resolveHost = (Array.isArray(resolveRoom) ? String(resolveRoom[1]) : String(resolveRoom.host)).toLowerCase();
      const resolveDeadline = Number(Array.isArray(resolveRoom) ? resolveRoom[10] : resolveRoom.phaseDeadline);
      const nowSec = Math.floor(Date.now() / 1000);

      const callerMainWallet = String(mainWallet).toLowerCase();
      const isHost = callerMainWallet === resolveHost || sigCheck.signer === resolveHost;
      const isGM = callerMainWallet === GM_ADDRESS.toLowerCase() || sigCheck.signer === GM_ADDRESS.toLowerCase();
      const deadlineExpired = resolveDeadline > 0 && (nowSec + 30) > resolveDeadline;

      if (!isHost && !isGM) {
        if (!deadlineExpired) {
          return res.status(403).json({ error: 'Only the room host or GM can trigger resolve-night before deadline' });
        }
        const resolvePlayers = await getPlayers(rid, chainId);
        const isParticipant = resolvePlayers.some(
          (p: any) => p.wallet.toLowerCase() === callerMainWallet || p.wallet.toLowerCase() === sigCheck.signer,
        );
        if (!isParticipant) {
          return res.status(403).json({ error: 'Caller is not a participant in this room' });
        }
      }

      if (resolvePhase !== GamePhase.NIGHT) {
        return res.status(400).json({ error: `Room is not in NIGHT phase (current: ${resolvePhase})` });
      }

      const state = getNightState(rid);
      if (!state || state.actions.size === 0) return res.status(400).json({ error: 'No night actions submitted' });
      if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

      const allActions = [...state.actions.values()];
      const killTarget = calculateMafiaConsensus(allActions);
      const healTarget = getDoctorHeal(allActions);

      console.log(`[resolve] Room ${roomId}: kill=${killTarget}, heal=${healTarget}, actions=${allActions.length}`);

      state.resolved = true;
      rPersistNightState(getRedis(), String(roomId), state);
      const { hash } = await resolveNight(rid, killTarget, healTarget, chainId);

      clearNightState(rid);
      rDeleteNightState(getRedis(), String(roomId));

      return res.json({ ok: true, txHash: hash, killTarget, healTarget });
    } catch (err: any) {
      console.error('[resolve-night] Error:', err.message);
      try {
        const rid = BigInt(req.body.roomId);
        const state = getNightState(rid);
        if (state) { state.resolved = false; rPersistNightState(getRedis(), String(req.body.roomId), state); }
      } catch { /* ignore */ }
      const isGasTxError = /gas required|insufficient funds|exceed|allowance|Execution reverted/i.test(err.message || '');
      return res.status(500).json({ error: err.message, gmTxFailed: isGasTxError });
    }
  });

  // ── Role Commit Sync ──────────────────────────────────────
  router.post('/role-commit-sync', actionLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, txHash, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      if (!roomId || !playerAddress || !signature) {
        return res.status(401).json({ error: 'Auth required: provide roomId, playerAddress, signature' });
      }
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `sync-role-commit:${roomId}:${txHash || ''}`,
        buildModernMessage: (n, ts) => `sync-role-commit:${roomId}:${txHash || ''}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });
      console.log(`[role-commit-sync] Room ${roomId}: ${playerAddress} committed role`);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error('[role-commit-sync] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Night Status ──────────────────────────────────────────
  router.get('/night-status/:roomId', pollLimiter, (req, res) => {
    const rid = BigInt(req.params.roomId);
    const state = getNightState(rid);
    if (!state) return res.json({ active: false, actionsReceived: 0 });
    return res.json({ active: true, actionsReceived: state.actions.size, resolved: state.resolved, startedAt: state.nightStartedAt });
  });

  // ── Investigation Proof ───────────────────────────────────
  router.post('/investigation-proof', actionLimiter, async (req, res) => {
    try {
      const { roomId, detectiveAddress, targetAddress, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      if (!roomId || !detectiveAddress || !targetAddress || !signature) {
        return res.status(400).json({ error: 'Missing fields' });
      }

      const rid = BigInt(roomId);
      const detective = String(detectiveAddress).toLowerCase();
      const target = String(targetAddress).toLowerCase();
      const signer = String(signerAddress || detectiveAddress).toLowerCase();

      let valid = false;
      if (nonce && timestamp !== undefined) {
        const tsNum = Number(timestamp);
        const age = Date.now() - tsNum;
        if (age > 300000 || age < -30000) {
          return res.status(401).json({ error: 'Timestamp expired' });
        }
        const { verifyMessage } = await import('viem');
        valid = await verifyMessage({
          address: signer as Address,
          message: `investigate:${roomId}:${req.body.dayCount || 0}:${target}:${nonce}:${tsNum}`,
          signature: signature as `0x${string}`,
        });
      }
      if (!valid) {
        const { verifyMessage } = await import('viem');
        valid = await verifyMessage({
          address: signer as Address,
          message: `investigate:${roomId}:${target}`,
          signature: signature as `0x${string}`,
        });
      }
      if (!valid) return res.status(401).json({ error: 'Invalid signature' });

      if (signer !== detective) {
        const session = await getSessionKey(detective as Address, chainId) as any;
        const sessionAddress = String(session.sessionAddress || '').toLowerCase();
        const expiresAt = Number(session.expiresAt || 0);
        const sessionRoomId = Number(session.roomId || 0);
        const isActive = Boolean(session.isActive);
        if (!sessionAddress || sessionAddress !== signer) {
          return res.status(403).json({ error: 'Session key not registered for this detective' });
        }
        if (!isActive || expiresAt <= Math.floor(Date.now() / 1000)) {
          return res.status(403).json({ error: 'Session key inactive or expired' });
        }
        if (sessionRoomId !== Number(rid)) {
          return res.status(403).json({ error: 'Session key room mismatch' });
        }
      }

      const proof = investigationProofs.get(String(rid))?.get(detective);
      if (!proof) return res.status(404).json({ error: 'No detective proof found' });
      if (String(proof.targetAddress).toLowerCase() !== target) {
        return res.status(403).json({ error: 'Investigation target mismatch' });
      }

      const roomRoles = resolvedRoles.get(String(rid));
      const targetRole = roomRoles?.get(target) || null;

      return res.json({ ok: true, source: 'gm-proof', targetAddress: proof.targetAddress, role: targetRole, timestamp: proof.timestamp });
    } catch (err: any) {
      console.error('[investigation-proof] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

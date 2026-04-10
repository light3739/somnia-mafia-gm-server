/**
 * routes/roomRoutes.ts
 */
import { Router } from 'express';
import { keccak256, toBytes, type Address } from 'viem';
import { getRoom, getPlayers, signJoinPermit, getTournament, isTournamentParticipant, somniaTestnet, FLAGS } from '../chain.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';
import { wsManager } from '../ws/wsManager.js';

import { logger } from '../utils/logger.js';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export interface RoomRoutesContext {
  store: GMStore;
  redis: RedisClient;
  verifyAuthorizedSignature: any; // AuthService verification function
  actionLimiter: RateLimitRequestHandler;
  pollLimiter: RateLimitRequestHandler;
}

export function createRoomRoutes(ctx: RoomRoutesContext) {
  const router = Router();
  const { store, redis, verifyAuthorizedSignature, actionLimiter, pollLimiter } = ctx;

  const getPasswordKey = (chainId: number | undefined, roomId: string) =>
    `room:password:${chainId || somniaTestnet.id}:${roomId}`;

  // ── Set Room Password ─────────────────────────────────────
  router.post('/room-password', actionLimiter, async (req, res) => {
    try {
      const { roomId, password, hostAddress, signature, signerAddress, nonce, timestamp, chainId } = req.body;

      if (!roomId || !password || !hostAddress || !signature) {
        return res.status(400).json({ error: 'Missing req fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId),
        playerAddress: String(hostAddress),
        signature: String(signature) as `0x${string}`,
        signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('setRoomPassword', chainId, roomId).withAddress(hostAddress).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('setRoomPassword', chainId, roomId).withAddress(hostAddress).withModern(n, ts).build(),
      });

      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Host verification
      let room: any = null;
      for (let i = 0; i < 5; i++) {
        try {
          room = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
          if (room?.host && room.host !== ZERO_ADDR) break;
        } catch (e: any) {
          logger.warn({ roomId, err: e.message }, `[room-password] Room lookup failed (attempt ${i + 1})`);
        }
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }

      if (!room?.host || room.host === ZERO_ADDR) return res.status(404).json({ error: 'Room not found' });
      if (room.host.toLowerCase() !== hostAddress.toLowerCase()) return res.status(403).json({ error: 'Only host can set password' });

      // Tournament check
      if (room.tournamentId && room.tournamentId > 0n) {
        const isPart = await isTournamentParticipant(room.tournamentId, hostAddress, chainId);
        if (!isPart) return res.status(403).json({ error: 'Join tournament first' });
      }

      const passHash = keccak256(toBytes(password));
      const key = getPasswordKey(chainId ? Number(chainId) : undefined, String(roomId));

      if (redis) {
        await redis.set(key, passHash, 'EX', 86400);
      } else {
        // Fallback to memory on store instance instead of globalThis
        (store as any).__roomPasswords ??= {};
        (store as any).__roomPasswords[key] = passHash;
      }

      logger.info({ roomId, host: hostAddress, chainId }, `[room-password] Room password set successfully`);
      return res.json({ success: true });
    } catch (err: any) {
      logger.error({ err, roomId: req.body?.roomId }, '[room-password] Internal error');
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Request Join permit ───────────────────────────────────
  router.post('/request-join', actionLimiter, async (req, res) => {
    try {
      const { roomId, password, playerAddress, chainId } = req.body;
      if (!roomId || !password || !playerAddress) return res.status(400).json({ error: 'Missing fields' });

      const key = getPasswordKey(chainId ? Number(chainId) : undefined, String(roomId));
      const storedHash = redis
        ? await redis.get(key)
        : (store as any).__roomPasswords?.[key] || null;

      if (!storedHash) return res.status(404).json({ error: 'No password set' });

      const providedHash = keccak256(toBytes(password));
      if (providedHash !== storedHash) return res.status(403).json({ error: 'Wrong password' });

      // We do not check `isTournamentParticipant` here because the player might use `joinTournamentAndRoom` 
      // atomically, meaning they aren't a participant yet but need the permit to submit the tx.

      const gmSignature = await signJoinPermit(BigInt(roomId), playerAddress as `0x${string}`, chainId ? Number(chainId) : somniaTestnet.id);
      logger.info({ roomId, player: playerAddress, chainId }, '[request-join] Join permit granted');
      return res.json({ success: true, gmSignature });
    } catch (err: any) {
      logger.error({ err, roomId: req.body?.roomId }, '[request-join] Internal error');
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Rematch Invite ───────────────────────────────────────
  // Host of a finished game calls this to broadcast a rematch invite to all
  // players still subscribed to the old room's WS channel. Payload contains
  // the newly-created room's id so clients can auto-join.
  router.post('/rematch-invite', actionLimiter, async (req, res) => {
    try {
      const {
        oldRoomId,
        newRoomId,
        hostAddress,
        signature,
        signerAddress,
        nonce,
        timestamp,
        chainId,
        lobbyName,
        maxPlayers,
        isPrivate,
      } = req.body;

      if (!oldRoomId || !newRoomId || !hostAddress || !signature) {
        return res.status(400).json({ error: 'Missing req fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(oldRoomId),
        playerAddress: String(hostAddress),
        signature: String(signature) as `0x${string}`,
        signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('sendRematchInvite', chainId, oldRoomId).withAddress(hostAddress).withParam(String(newRoomId)).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('sendRematchInvite', chainId, oldRoomId).withAddress(hostAddress).withParam(String(newRoomId)).withModern(n, ts).build(),
      });

      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Verify the caller was actually the host of the finished (old) room.
      let oldRoom: any = null;
      try {
        oldRoom = await getRoom(BigInt(oldRoomId), chainId ? Number(chainId) : undefined);
      } catch (e: any) {
        logger.warn({ oldRoomId, err: e.message }, '[rematch-invite] Old room lookup failed');
      }
      if (!oldRoom?.host || oldRoom.host === ZERO_ADDR) return res.status(404).json({ error: 'Old room not found' });
      if (oldRoom.host.toLowerCase() !== String(hostAddress).toLowerCase()) {
        return res.status(403).json({ error: 'Only the old room host can send a rematch invite' });
      }

      // Verify the new room actually exists and has the same host.
      let newRoom: any = null;
      for (let i = 0; i < 5; i++) {
        try {
          newRoom = await getRoom(BigInt(newRoomId), chainId ? Number(chainId) : undefined);
          if (newRoom?.host && newRoom.host !== ZERO_ADDR) break;
        } catch (e: any) {
          logger.warn({ newRoomId, err: e.message }, `[rematch-invite] New room lookup failed (attempt ${i + 1})`);
        }
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
      if (!newRoom?.host || newRoom.host === ZERO_ADDR) return res.status(404).json({ error: 'New room not found on-chain' });
      if (newRoom.host.toLowerCase() !== String(hostAddress).toLowerCase()) {
        return res.status(403).json({ error: 'New room host mismatch' });
      }

      const effectiveChainId = chainId ? Number(chainId) : somniaTestnet.id;
      wsManager.broadcastToRoom(String(oldRoomId), effectiveChainId, {
        type: 'rematch-invite',
        data: {
          oldRoomId: String(oldRoomId),
          newRoomId: String(newRoomId),
          hostAddress: String(hostAddress).toLowerCase(),
          lobbyName: String(lobbyName || newRoom.name || ''),
          maxPlayers: Number(maxPlayers || newRoom.maxPlayers || 10),
          isPrivate: Boolean(isPrivate ?? newRoom.isPrivate),
          chainId: effectiveChainId,
        },
      });

      logger.info({ oldRoomId, newRoomId, host: hostAddress, chainId: effectiveChainId }, '[rematch-invite] Broadcasted rematch invite');
      return res.json({ success: true });
    } catch (err: any) {
      logger.error({ err, oldRoomId: req.body?.oldRoomId }, '[rematch-invite] Internal error');
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Room Info Proxy ─────────────────────────────────────
  router.get('/room/:roomId', pollLimiter, async (req, res) => {
    try {
      const rid = BigInt(req.params.roomId);
      const chainIdNum = req.query.chainId ? Number(req.query.chainId) : undefined;
      const [room, players] = await Promise.all([getRoom(rid, chainIdNum), getPlayers(rid, chainIdNum)]);
      return res.json({
        room: {
          id: Number(room.id),
          host: room.host,
          name: room.name,
          phase: room.phase,
          maxPlayers: room.maxPlayers,
          playersCount: room.playersCount,
          dayCount: room.dayCount,
          isPrivate: room.isPrivate,
          tournamentId: room.tournamentId ? String(room.tournamentId) : '0',
        },
        players: players.map((p: any) => ({
          wallet: p.wallet,
          nickname: p.nickname,
          active: !!(Number(p.flags) & FLAGS.ACTIVE),
        })),
      });
    } catch (err: any) {
      // Don't log normal 404s/errors for polling unless it's unexpected
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

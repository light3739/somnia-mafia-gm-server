/**
 * routes/roomRoutes.ts
 */
import { Router } from 'express';
import { keccak256, toBytes, type Address } from 'viem';
import { getRoom, getPlayers, signJoinPermit, getTournament, isTournamentParticipant, avalancheFuji, FLAGS } from '../chain.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

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
    `room:password:${chainId || avalancheFuji.id}:${roomId}`;

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
        buildLegacyMessage: () => `setRoomPassword:${chainId || 43113}:${roomId}:${String(hostAddress).toLowerCase()}`,
        buildModernMessage: (n: string, ts: number) => `setRoomPassword:${chainId || 43113}:${roomId}:${String(hostAddress).toLowerCase()}:${n}:${ts}`,
      });

      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Host verification
      let room: any = null;
      for (let i = 0; i < 5; i++) {
        try {
          room = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
          if (room?.host && room.host !== ZERO_ADDR) break;
        } catch (e: any) {
          console.warn(`[room-password] Room lookup failed: ${e.message}`);
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

      console.log(`[room-password] Room ${roomId}: set by ${hostAddress}`);
      return res.json({ success: true });
    } catch (err: any) {
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

      const room = await getRoom(BigInt(roomId), chainId);
      if (room?.tournamentId && room.tournamentId > 0n) {
        const isPart = await isTournamentParticipant(room.tournamentId, playerAddress as Address, chainId);
        if (!isPart) return res.status(403).json({ error: 'Join tournament first' });
      }

      const gmSignature = await signJoinPermit(BigInt(roomId), playerAddress as `0x${string}`, chainId ? Number(chainId) : avalancheFuji.id);
      return res.json({ success: true, gmSignature });
    } catch (err: any) {
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
        },
        players: players.map((p: any) => ({
          wallet: p.wallet,
          nickname: p.nickname,
          active: !!(Number(p.flags) & FLAGS.ACTIVE),
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

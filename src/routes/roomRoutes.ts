/**
 * routes/roomRoutes.ts
 * POST /room-password    — host sets a password
 * POST /request-join     — player sends password, receives GM signature
 * GET  /room/:roomId     — room + player info proxy
 */
import { Router } from 'express';
import { keccak256, toBytes, type Address } from 'viem';
import { verifyAuthorizedSignature } from '../auth/verifySignature.js';
import { getRoom, getPlayers, signJoinPermit, getTournament, isTournamentParticipant, avalancheFuji, FLAGS } from '../chain.js';
import { getRedis } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function getPasswordKey(chainId: number | undefined, roomId: string): string {
  return `room:password:${chainId || avalancheFuji.id}:${roomId}`;
}

export function createRoomRoutes(
  actionLimiter: RateLimitRequestHandler,
  pollLimiter: RateLimitRequestHandler,
) {
  const router = Router();

  // ── Set Room Password ─────────────────────────────────────
  router.post('/room-password', actionLimiter, async (req, res) => {
    try {
      const { roomId, password, hostAddress, signature, signerAddress, nonce, timestamp, chainId } = req.body;

      if (!roomId || !password || !hostAddress || !signature) {
        return res.status(400).json({ error: 'Missing fields: roomId, password, hostAddress, signature' });
      }
      if (typeof password !== 'string' || password.length < 1 || password.length > 64) {
        return res.status(400).json({ error: 'Password must be 1-64 characters' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId),
        playerAddress: String(hostAddress),
        signature: String(signature) as `0x${string}`,
        signerAddress: signerAddress ? String(signerAddress) : undefined,
        nonce: nonce ? String(nonce) : undefined,
        timestamp: timestamp ? Number(timestamp) : undefined,
        chainId: chainId ? Number(chainId) : undefined,
        buildLegacyMessage: () => `setRoomPassword:${roomId}:${String(hostAddress).toLowerCase()}`,
        buildModernMessage: (n, ts) => `setRoomPassword:${roomId}:${String(hostAddress).toLowerCase()}:${n}:${ts}`,
      });

      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Verify host with retry
      let room: any = null;
      for (let i = 0; i < 5; i++) {
        try {
          room = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
          if (room?.host && room.host !== ZERO_ADDR) break;
        } catch (e: any) {
          console.warn(`[room-password] Room ${roomId} lookup attempt ${i + 1}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }

      if (!room?.host || room.host === ZERO_ADDR) {
        return res.status(404).json({ error: 'Room not found on chain yet. Please retry.' });
      }
      if (room.host.toLowerCase() !== hostAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Only the room host can set a password' });
      }

      // Tournament check
      if (room.tournamentId && room.tournamentId > 0n) {
        const tournament = await getTournament(room.tournamentId, chainId) as any;
        if (tournament?.buyIn > 0n) {
          const isPart = await isTournamentParticipant(room.tournamentId, hostAddress, chainId);
          if (!isPart) return res.status(403).json({ error: 'Must join tournament first to host this room' });
        }
      }

      const passHash = keccak256(toBytes(password));
      const redis = getRedis();
      const key = getPasswordKey(chainId ? Number(chainId) : undefined, String(roomId));
      if (redis) {
        await redis.set(key, passHash, 'EX', 86400);
      } else {
        (globalThis as any).__roomPasswords ??= {};
        (globalThis as any).__roomPasswords[key] = passHash;
      }

      console.log(`[room-password] Room ${roomId}: password set by ${hostAddress}`);
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[room-password] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Request Join Permit ───────────────────────────────────
  router.post('/request-join', actionLimiter, async (req, res) => {
    try {
      const { roomId, password, playerAddress, chainId } = req.body;
      if (!roomId || !password || !playerAddress) {
        return res.status(400).json({ error: 'Missing fields: roomId, password, playerAddress' });
      }

      const redis = getRedis();
      const key = getPasswordKey(chainId ? Number(chainId) : undefined, String(roomId));
      const storedHash = redis
        ? await redis.get(key)
        : (globalThis as any).__roomPasswords?.[key] || null;

      if (!storedHash) {
        return res.status(404).json({ error: 'No password set for this room (room is public or expired)' });
      }

      const providedHash = keccak256(toBytes(password));
      if (providedHash !== storedHash) return res.status(403).json({ error: 'Wrong password' });

      // Tournament check
      const room = await getRoom(BigInt(roomId), chainId);
      if (room?.tournamentId && room.tournamentId > 0n) {
        const tournament = await getTournament(room.tournamentId, chainId) as any;
        if (tournament?.buyIn > 0n) {
          const isPart = await isTournamentParticipant(room.tournamentId, playerAddress as Address, chainId);
          if (!isPart) return res.status(403).json({ error: 'Must join tournament first' });
        }
      }

      const gmSignature = await signJoinPermit(
        BigInt(roomId),
        playerAddress as `0x${string}`,
        chainId ? Number(chainId) : avalancheFuji.id,
      );

      console.log(`[request-join] Room ${roomId}: join permit issued for ${playerAddress}`);
      return res.json({ success: true, gmSignature });
    } catch (err: any) {
      console.error('[request-join] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Room Info ─────────────────────────────────────────────
  router.get('/room/:roomId', pollLimiter, async (req, res) => {
    try {
      const rid = BigInt(req.params.roomId);
      const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
      const [room, players] = await Promise.all([getRoom(rid, chainId), getPlayers(rid, chainId)]);
      return res.json({
        room: {
          id: Number(room.id),
          host: room.host,
          name: room.name,
          phase: room.phase,
          phaseLabel: ['LOBBY', 'SHUFFLING', 'REVEAL', 'DAY', 'VOTING', 'NIGHT', 'ENDED'][room.phase],
          maxPlayers: room.maxPlayers,
          playersCount: room.playersCount,
          aliveCount: room.aliveCount,
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

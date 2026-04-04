/**
 * routes/winRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, FLAGS } from '../chain.js';
import { Role } from '../types/contract.js';
import type { GMStore } from '../stores/index.js';
import { ServerStore } from '../services/serverStore.js';
import { generateEndGameProof, calculatePoseidon } from '../zk.js';
import { Mutex } from 'async-mutex';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

import { logger } from '../utils/logger.js';

const zkMutex = new Mutex();

export interface WinRoutesContext {
  store: GMStore;
  verifyAuthorizedSignature: any;
  pollLimiter: RateLimitRequestHandler;
  heavyLimiter: RateLimitRequestHandler;
}

export function createWinRoutes(ctx: WinRoutesContext) {
  const router = Router();
  const { store, verifyAuthorizedSignature, pollLimiter, heavyLimiter } = ctx;

  router.post('/hash-role', async (req, res) => {
    try {
      const { role, salt } = req.body;
      const mappedRole = Number(role) === 1 ? 1 : 0;
      const commitment = await calculatePoseidon([BigInt(mappedRole), BigInt("0x" + (salt.startsWith('0x') ? salt.slice(2) : salt))]);
      return res.json({ commitment });
    } catch (e: any) {
      logger.error({ err: e.message }, '[hash-role] Poseidon calculation failed');
      return res.status(500).json({ error: e.message });
    }
  });

  router.post('/submit-role-secret', heavyLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, role, salt, commitment, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      if (!roomId || !playerAddress || !salt || !commitment || !signature) {
        return res.status(400).json({ error: 'Missing fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('submit-role-secret', chainId, roomId).withParam(role).withParam(salt).withParam(commitment).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('submit-role-secret', chainId, roomId).withParam(role).withParam(salt).withParam(commitment).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Optional: Verify commitment against role+salt
      const mappedRole = Number(role) === 1 ? 1 : 0;
      const computed = await calculatePoseidon([BigInt(mappedRole), BigInt("0x" + salt.replace("0x",""))]);
      if (computed !== commitment) {
        logger.warn({ roomId, player: playerAddress, computed, received: commitment }, '[submit-role-secret] Commitment mismatch');
        return res.status(400).json({ error: 'Commitment mismatch' });
      }

      await ServerStore.storeSecret(String(roomId), String(playerAddress), Number(role), String(salt), String(commitment), chainId);
      logger.info({ roomId, player: playerAddress, role }, '[submit-role-secret] Secret stored');
      
      return res.json({ ok: true });
    } catch (e: any) {
      logger.error({ err: e.message, roomId: req.body?.roomId, player: req.body?.playerAddress }, '[submit-role-secret] Internal error');
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/win-check/:roomId', pollLimiter, async (req, res) => {
    try {
      const rid = BigInt(req.params.roomId);
      const cid = req.query.chainId ? Number(req.query.chainId) : undefined;
      const effectiveCid = cid || 50312;
      const roomKey = store.getRoomKey(effectiveCid, req.params.roomId);
      const [room, players] = await Promise.all([getRoom(rid, effectiveCid), getPlayers(rid, effectiveCid)]);
      
      let roles = store.resolvedRoles.get(roomKey);

      // Fallback: Restore roles from Redis if memory is empty
      if ((!roles || roles.size === 0) && (room.phase >= 3 && room.phase <= 5)) {
        try {
          const { getRedis } = await import('../redis.js');
          const redis = getRedis();
          if (redis) {
            const pattern = `gm:room:${effectiveCid}:${req.params.roomId}:role:*`;
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
                 logger.info({ roomId: req.params.roomId, count: restoredRoles.size }, '[win-check] Restored roles from Redis');
              }
            }
          }
        } catch (err: any) {
          logger.error({ err: err.message, roomId: req.params.roomId }, '[win-check] Failed to fallback read roles from Redis');
        }
      }

      if (room.phase < 3 || room.phase > 5) return res.json({ winDetected: false, message: "Game not active" });
      if (!roles || roles.size === 0) return res.json({ winDetected: false });

      let mafiaCount = 0, townCount = 0;
      for (const p of players) {
        if (Number(p.flags) & FLAGS.ACTIVE) {
          const r = roles.get(p.wallet.toLowerCase());
          if (r === Role.MAFIA) mafiaCount++;
          else if (r !== undefined && r !== Role.NONE) townCount++;
        }
      }
      if (mafiaCount === 0) {
        logger.info({ roomId: req.params.roomId }, '[win-check] Town wins detected');
        return res.json({ winDetected: true, result: 'TOWN_WIN' });
      }
      if (mafiaCount >= townCount) {
        logger.info({ roomId: req.params.roomId }, '[win-check] Mafia wins detected');
        return res.json({ winDetected: true, result: 'MAFIA_WIN' });
      }
      return res.json({ winDetected: false });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.post('/end-game-zk/:roomId', heavyLimiter, async (req, res) => {
    const roomId = req.params.roomId;
    try {
      const cid = req.body.chainId;
      const secrets = await ServerStore.getRoomSecrets(roomId, cid);
      if (!secrets) {
        logger.warn({ roomId }, '[end-game-zk] No secrets found');
        return res.status(400).json({ error: 'No secrets found for this room. Players must submit secrets first.' });
      }
      
      const players = await getPlayers(BigInt(roomId), cid);
      const zkInput = players.map((p: any) => {
        const addr = p.wallet.toLowerCase();
        const s = secrets[addr];
        const alive = !!(Number(p.flags) & FLAGS.ACTIVE);
        return {
          role: s?.role === 1 ? 1 : 0,
          salt: s ? s.salt : "0".repeat(64),
          commitment: s ? s.commitment : "14744269619966411208579211824598458697587494354926760081771325075741142829156",
          isActive: alive ? 1 : 0,
        };
      });

      logger.info({ roomId }, '[end-game-zk] Starting ZK proof generation...');
      const callData = await zkMutex.runExclusive(async () => {
        const start = Date.now();
        const data = await generateEndGameProof(roomId, zkInput);
        logger.info({ roomId, duration: Date.now() - start }, '[end-game-zk] ZK proof generated successfully');
        return data;
      });
      return res.json({ callData });
    } catch (err: any) {
      logger.error({ err: err.message, roomId }, '[end-game-zk] ZK proof generation failed');
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

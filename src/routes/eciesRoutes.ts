/**
 * routes/eciesRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, getChainConfig, DIAMOND_ABI, FLAGS, GamePhase } from '../chain.js';
import { Role } from '../types/contract.js';
import { eciesEncrypt } from '../ecies.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';
import { submitSraKey } from '../services/roleResolution.js';

import { logger } from '../utils/logger.js';

export interface EciesRoutesContext {
  store: GMStore;
  redis: RedisClient;
  verifyAuthorizedSignature: any;
  actionLimiter: RateLimitRequestHandler;
  pollLimiter: RateLimitRequestHandler;
}

export function createEciesRoutes(ctx: EciesRoutesContext) {
  const router = Router();
  const { store, redis, verifyAuthorizedSignature, actionLimiter, pollLimiter } = ctx;

  router.post('/register-pubkey', actionLimiter, async (req, res) => {
    const { roomId, playerAddress, pubkey, signature, signerAddress, nonce, timestamp, chainId } = req.body;
    if (!roomId || !playerAddress || !pubkey || !signature) return res.status(400).json({ error: 'Missing fields' });

    const normalizedAddr = String(playerAddress).toLowerCase();
    const sigCheck = await verifyAuthorizedSignature({
      roomId: String(roomId), signature: signature as `0x${string}`,
      playerAddress: normalizedAddr, signerAddress, nonce, timestamp, chainId,
      buildLegacyMessage: () => new SignatureBuilder('register-pubkey', chainId, roomId).withAddress(normalizedAddr).withParam(pubkey).build(),
      buildModernMessage: (n: string, ts: number) => new SignatureBuilder('register-pubkey', chainId, roomId).withAddress(normalizedAddr).withParam(pubkey).withModern(n, ts).build(),
    });
    if (!sigCheck.ok) return res.status(sigCheck.status || 401).json({ error: sigCheck.error });

    const room: any = await getRoom(BigInt(roomId), chainId);
    const phase = Number(room.phase);
    if (phase !== GamePhase.REVEAL && phase !== GamePhase.ENDED && phase !== GamePhase.LOBBY && phase !== GamePhase.SHUFFLING) {
      return res.status(400).json({ error: 'Unauthorized phase for pubkey' });
    }

    const roomKey = store.getRoomKey(Number(chainId), String(roomId));
    store.getRoomMap(store.eciesPubkeys, roomKey).set(normalizedAddr, pubkey);
    const { rPersistPubkey, rPersistRoomChain } = await import('../redis.js');
    if (redis) {
      rPersistPubkey(redis, Number(chainId), String(roomId), normalizedAddr, pubkey);
      rPersistRoomChain(redis, Number(chainId), String(roomId));
    }
    
    logger.info({ roomId, player: normalizedAddr, chainId }, '[register-pubkey] ECIES pubkey registered');
    return res.json({ ok: true });
  });

  router.post('/submit-sra-key', actionLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, sraKey, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('submit-key', chainId, roomId).withParam(sraKey).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('submit-key', chainId, roomId).withParam(sraKey).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status || 401).json({ error: sigCheck.error });

      await submitSraKey(
        {
          store,
          redis,
          chainId: Number(chainId),
          roomId: String(roomId),
          fetchPlayers: async () =>
            (await getPlayers(BigInt(roomId), chainId)).map((p) => ({ wallet: p.wallet })),
          fetchDeck: async () => {
            const { public: pc, diamond } = getChainConfig(chainId);
            return (await pc.readContract({
              address: diamond,
              abi: DIAMOND_ABI,
              functionName: "getDeck",
              args: [BigInt(roomId)],
            })) as string[];
          },
        },
        String(playerAddress),
        String(sraKey)
      );

      logger.info({ roomId, player: String(playerAddress).toLowerCase(), chainId }, "[submit-sra-key] SRA key submitted");
      return res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err, roomId: req.body?.roomId }, '[submit-sra-key] Internal error');
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/my-role/:roomId', pollLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { playerAddress, signature, signerAddress, nonce, timestamp, chainId } = req.query as Record<string, string>;
      const sigCheck = await verifyAuthorizedSignature({
        roomId, signature: signature as `0x${string}`, playerAddress, signerAddress, nonce, timestamp: Number(timestamp), chainId,
        buildLegacyMessage: () => new SignatureBuilder('my-role', chainId, roomId).withAddress(playerAddress).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('my-role', chainId, roomId).withAddress(playerAddress).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const roomKey = store.getRoomKey(Number(chainId), roomId);
      const pubkey = store.eciesPubkeys.get(roomKey)?.get(String(playerAddress).toLowerCase());
      if (!pubkey) return res.status(404).json({ error: 'ECIES pubkey missing' });

      let role = store.resolvedRoles.get(roomKey)?.get(String(playerAddress).toLowerCase());
      if (!role) {
        return res.status(202).json({ pending: true, message: 'Retry shortly' });
      }

      const { rPersistRole } = await import('../redis.js');
      if (redis) rPersistRole(redis, Number(chainId), String(roomId), String(playerAddress).toLowerCase(), role);

      const encrypted = eciesEncrypt(pubkey, String(role)); // encode as string for ECIES
      return res.json({ encrypted, roleId: role });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/mafia-members/:roomId', pollLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { playerAddress, signature, signerAddress, nonce, timestamp, chainId } = req.query as Record<string, string>;
      
      const sigCheck = await verifyAuthorizedSignature({
        roomId, signature: signature as `0x${string}`, 
        playerAddress, signerAddress, nonce, 
        timestamp: Number(timestamp), chainId,
        buildLegacyMessage: () => new SignatureBuilder('mafia-members', chainId, roomId).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('mafia-members', chainId, roomId).withModern(n, ts).build(),
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Phase gate: only allow during NIGHT or after game ENDED
      const room = await getRoom(BigInt(roomId), Number(chainId));
      const phase = Number(room.phase);
      if (phase !== GamePhase.NIGHT && phase !== GamePhase.ENDED) {
        return res.status(403).json({ error: 'Only available during NIGHT phase or after game ends' });
      }

      const roomKey = store.getRoomKey(Number(chainId), roomId);
      const roles = store.resolvedRoles.get(roomKey);
      if (!roles) return res.status(202).json({ pending: true, message: 'Roles not resolved yet' });

      // Verify the requester is actually Mafia
      const requesterRole = roles.get(String(playerAddress).toLowerCase());
      if (requesterRole !== Role.MAFIA) {
        return res.status(403).json({ error: 'Only Mafia members can see each other' });
      }

      // Return all Mafia members
      const mafiaMembers: string[] = [];
      for (const [addr, role] of roles.entries()) {
        if (role === Role.MAFIA) mafiaMembers.push(addr);
      }

      return res.json({ members: mafiaMembers });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/room-roles/:roomId', pollLimiter, async (req, res) => {
    // Roles are public ONLY after game ends.
    const { chainId } = req.query as Record<string, string>;
    const effectiveCid = Number(chainId) || 50312;

    // Phase check: only reveal roles after game ends
    try {
      const room = await getRoom(BigInt(req.params.roomId), effectiveCid);
      if (Number(room.phase) !== GamePhase.ENDED) {
        return res.status(202).json({ pending: true, message: 'Roles available after game ends' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid room' });
    }

    const roomKey = store.getRoomKey(effectiveCid, req.params.roomId);
    let cached = store.resolvedRoles.get(roomKey);

    // Fallback: restore roles from Redis if memory is empty (e.g. after server restart)
    if (!cached || cached.size === 0) {
      try {
        const pattern = `gm:room:${effectiveCid}:${req.params.roomId}:role:*`;
        const keys = redis ? await redis.keys(pattern) : [];
        if (keys.length > 0) {
          const vals = redis ? await redis.mget(keys) : [];
          const restoredRoles = new Map<string, number>();
          for (let i = 0; i < keys.length; i++) {
            if (vals[i]) {
              const addr = keys[i].split(':')[5];
              restoredRoles.set(addr, Number(vals[i]));
            }
          }
          if (restoredRoles.size > 0) {
            store.resolvedRoles.set(roomKey, restoredRoles as any);
            cached = restoredRoles as any;
            logger.info({ roomId: req.params.roomId, count: restoredRoles.size }, '[room-roles] Restored roles from Redis');
          }
        }
      } catch (err: any) {
        logger.error({ err: err.message }, '[room-roles] Redis fallback failed');
      }
    }

    if (!cached) return res.status(202).json({ pending: true });

    const result: Record<string, string> = {};
    const roleToString: Record<number, string> = {
      1: 'MAFIA', 2: 'DOCTOR', 3: 'DETECTIVE', 4: 'CIVILIAN'
    };
    for (const [addr, role] of cached.entries()) {
      result[addr.toLowerCase()] = roleToString[role as number] || 'UNKNOWN';
    }
    return res.json({ roles: result });
  });

  return router;
}

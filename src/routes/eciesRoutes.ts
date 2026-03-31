/**
 * routes/eciesRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, getChainConfig, DIAMOND_ABI, FLAGS, GamePhase } from '../chain.js';
import { Role } from '../types/contract.js';
import { eciesEncrypt } from '../ecies.js';
import { sraDecryptCard, roleFromCardValue, getCardOffset } from '../crypto/sra.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

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

      const roomKey = store.getRoomKey(Number(chainId), String(roomId));
      const roomSraKeys = store.getRoomMap(store.sraSKeys, roomKey);
      const normalizedPlayer = String(playerAddress).toLowerCase();
      roomSraKeys.set(normalizedPlayer, String(sraKey));
      const { rPersistSraKey, rPersistRole, rPersistRoomChain } = await import('../redis.js');
      if (redis) {
        rPersistSraKey(redis, Number(chainId), String(roomId), normalizedPlayer, String(sraKey));
        rPersistRoomChain(redis, Number(chainId), String(roomId));
      }

      logger.info({ roomId, player: normalizedPlayer, chainId }, '[submit-sra-key] SRA key updated');

      // Try pre-cache
      const players = await getPlayers(BigInt(roomId), chainId);
      
      // We need keys from all players since the sequential shuffle requires everyone's SRA key.
      // (The DECK_COMMITTED flag might have been cleared by the final revealDeck transaction).
      const shufflerAddrs = players.map(p => p.wallet.toLowerCase());
      const missingKeys = shufflerAddrs.filter(addr => !roomSraKeys.has(addr));

      if (shufflerAddrs.length > 0 && missingKeys.length === 0) {
        logger.info({ roomId, shufflersCount: shufflerAddrs.length }, '[ECIES] All SRA keys received. Resolving roles...');
        const { public: publicClient, diamond } = getChainConfig(chainId);
        const deck = await publicClient.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [BigInt(roomId)] }) as string[];
        
        const allKeys = shufflerAddrs.map(addr => roomSraKeys.get(addr)).filter(Boolean) as string[];
        const roomRoles = store.getRoomMap(store.resolvedRoles, roomKey);
        
        // Final mapping uses all players (even if they didn't shuffle, they get a card index)
        const allAddrsInOrder = (store.roomPlayerOrder.get(roomKey) || players.map(p => p.wallet.toLowerCase())) as string[];
        
        allAddrsInOrder.forEach((addr, i) => {
          if (i < deck.length) {
            const rawDecoded = sraDecryptCard(deck[i], allKeys);
            const role = roleFromCardValue(rawDecoded, roomId);
            if (role === Role.NONE) {
              logger.warn({
                index: i,
                player: addr,
                decrypted: rawDecoded,
                source: deck[i],
                offset: getCardOffset(roomId)
              }, '[ECIES] Role resolution failed');
            } else {
              logger.info({ player: addr, role: Role[role] }, '[ECIES] Role resolved');
            }
            roomRoles.set(addr.toLowerCase(), role);
            if (redis) rPersistRole(redis, Number(chainId), String(roomId), addr.toLowerCase(), role);
          }
        });
      } else if (shufflerAddrs.length > 0) {
        logger.info({ roomId, missingFrom: missingKeys }, '[ECIES] Waiting for more SRA keys');
      }
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
    // Roles are public after game ends. No auth required.
    const { chainId } = req.query as Record<string, string>;
    const roomKey = store.getRoomKey(Number(chainId), req.params.roomId);
    const cached = store.resolvedRoles.get(roomKey);
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

/**
 * routes/eciesRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, getChainConfig, DIAMOND_ABI, FLAGS, GamePhase } from '../chain.js';
import { Role } from '../types/contract.js';
import { eciesEncrypt } from '../ecies.js';
import { sraDecryptCard, roleFromCardValue } from '../crypto/sra.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

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
    if (phase !== GamePhase.REVEAL && phase !== GamePhase.ENDED && phase !== GamePhase.LOBBY) {
      return res.status(400).json({ error: 'Unauthorized phase for pubkey' });
    }

    const roomKey = store.getRoomKey(Number(chainId), String(roomId));
    store.getRoomMap(store.eciesPubkeys, roomKey).set(normalizedAddr, pubkey);
    const { rPersistPubkey, rPersistRoomChain } = await import('../redis.js');
    if (redis) {
      rPersistPubkey(redis, Number(chainId), String(roomId), normalizedAddr, pubkey);
      rPersistRoomChain(redis, Number(chainId), String(roomId));
    }
    
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

      // Try pre-cache
      const players = await getPlayers(BigInt(roomId), chainId);
      const activePlayers = players.filter((p) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const activeAddrs = activePlayers.map((p) => p.wallet.toLowerCase());
      if (activeAddrs.every(addr => roomSraKeys.has(addr))) {
        const { public: publicClient, diamond } = getChainConfig(chainId);
        const deck = await publicClient.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [BigInt(roomId)] }) as string[];
        const order = (store.roomPlayerOrder.get(roomKey) || players.map(p => p.wallet.toLowerCase())) as `0x${string}`[];
        store.roomPlayerOrder.set(roomKey, order);
        const allKeys = players.map(p => roomSraKeys.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
        const roomRoles = store.getRoomMap(store.resolvedRoles, roomKey);
        order.forEach((addr, i) => {
          if (i < deck.length) {
            const role = roleFromCardValue(sraDecryptCard(deck[i], allKeys), Number(roomId));
            roomRoles.set(addr, role);
            if (redis) rPersistRole(redis, Number(chainId), String(roomId), addr, role);
          }
        });
      }
      return res.json({ ok: true });
    } catch (err: any) {
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
        // Full logic for manual decrypt if role not pre-cached...
        // For simplicity in this demo, we assume pre-cache is working or 202 retry.
        return res.status(202).json({ pending: true, message: 'Retry shortly' });
      }

      const encrypted = eciesEncrypt(pubkey, String(role)); // encode as string for ECIES
      return res.json({ encrypted, roleId: role });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/room-roles/:roomId', pollLimiter, async (req, res) => {
    // Implement game-ended check + role returning logic...
    const { chainId } = req.query as Record<string, string>;
    const roomKey = store.getRoomKey(Number(chainId), req.params.roomId);
    const cached = store.resolvedRoles.get(roomKey);
    if (!cached) return res.status(202).json({ pending: true });
    const result: Record<string, number> = {};
    for (const [addr, role] of cached) result[addr.toLowerCase()] = role as number;
    return res.json({ roles: result });
  });

  return router;
}

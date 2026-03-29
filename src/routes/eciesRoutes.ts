/**
 * routes/eciesRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, getChainConfig, DIAMOND_ABI, FLAGS, GamePhase } from '../chain.js';
import { eciesEncrypt } from '../ecies.js';
import { sraDecryptCard, roleFromCardValue } from '../crypto/sra.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

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
      buildLegacyMessage: () => `register-pubkey:${roomId}:${normalizedAddr}:${pubkey}`,
      buildModernMessage: (n: string, ts: number) => `register-pubkey:${roomId}:${normalizedAddr}:${pubkey}:${n}:${ts}`,
    });
    if (!sigCheck.ok) return res.status(sigCheck.status || 401).json({ error: sigCheck.error });

    const room: any = await getRoom(BigInt(roomId), chainId);
    const phase = Number(room.phase);
    if (phase !== GamePhase.REVEAL && phase !== GamePhase.ENDED && phase !== GamePhase.LOBBY) {
      return res.status(400).json({ error: 'Unauthorized phase for pubkey' });
    }

    store.getRoomMap(store.eciesPubkeys, String(roomId)).set(normalizedAddr, pubkey);
    const { rPersistPubkey } = await import('../redis.js');
    if (redis) rPersistPubkey(redis, String(roomId), normalizedAddr, pubkey);
    
    return res.json({ ok: true });
  });

  router.post('/submit-sra-key', actionLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, sraKey, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `submit-key:${roomId}:${sraKey}`,
        buildModernMessage: (n: string, ts: number) => `submit-key:${roomId}:${sraKey}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status || 401).json({ error: sigCheck.error });

      const roomSraKeys = store.getRoomMap(store.sraSKeys, String(roomId));
      const normalizedPlayer = String(playerAddress).toLowerCase();
      roomSraKeys.set(normalizedPlayer, String(sraKey));
      const { rPersistSraKey, rPersistRole } = await import('../redis.js');
      if (redis) rPersistSraKey(redis, String(roomId), normalizedPlayer, String(sraKey));

      // Try pre-cache
      const players = await getPlayers(BigInt(roomId), chainId) as any[];
      const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
      if (activeAddrs.every(addr => roomSraKeys.has(addr))) {
        const { public: publicClient, diamond } = getChainConfig(chainId);
        const deck = await publicClient.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [BigInt(roomId)] }) as string[];
        const order = store.roomPlayerOrder.get(String(roomId)) || players.map(p => p.wallet.toLowerCase());
        store.roomPlayerOrder.set(String(roomId), order);
        const allKeys = players.map(p => roomSraKeys.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
        const roomRoles = store.getRoomMap(store.resolvedRoles, String(roomId));
        order.forEach((addr: string, i: number) => {
          if (i < deck.length) {
            const role = roleFromCardValue(sraDecryptCard(deck[i], allKeys), Number(roomId));
            roomRoles.set(addr, role);
            if (redis) rPersistRole(redis, String(roomId), addr, role);
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
        buildLegacyMessage: () => `my-role:${roomId}:${playerAddress.toLowerCase()}`,
        buildModernMessage: (n: string, ts: number) => `my-role:${roomId}:${playerAddress.toLowerCase()}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const pubkey = store.eciesPubkeys.get(String(roomId))?.get(String(playerAddress).toLowerCase());
      if (!pubkey) return res.status(404).json({ error: 'ECIES pubkey missing' });

      let role = store.resolvedRoles.get(String(roomId))?.get(String(playerAddress).toLowerCase());
      if (!role) {
        // Full logic for manual decrypt if role not pre-cached...
        // For simplicity in this demo, we assume pre-cache is working or 202 retry.
        return res.status(202).json({ pending: true, message: 'Retry shortly' });
      }

      const encrypted = eciesEncrypt(pubkey, role);
      return res.json({ encrypted });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/room-roles/:roomId', pollLimiter, async (req, res) => {
    // Implement game-ended check + role returning logic...
    const cached = store.resolvedRoles.get(String(req.params.roomId));
    if (!cached) return res.status(202).json({ pending: true });
    const result: Record<string, string> = {};
    for (const [addr, role] of cached) result[addr.toLowerCase()] = role;
    return res.json({ roles: result });
  });

  return router;
}

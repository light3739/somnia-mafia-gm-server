/**
 * routes/avatarRoutes.ts
 * Standardized routes for player avatars.
 */
import { Router } from 'express';
import { ServerStore } from '../services/serverStore.js';
import type { GMStore } from '../stores/index.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

export interface AvatarRoutesContext {
  store: GMStore;
  verifyAuthorizedSignature: any;
  actionLimiter: RateLimitRequestHandler;
  pollLimiter: RateLimitRequestHandler;
}

export function createAvatarRoutes(ctx: AvatarRoutesContext) {
  const router = Router();
  const { verifyAuthorizedSignature, actionLimiter, pollLimiter } = ctx;

  // ── GET /avatars/:roomId ──────────────────────────────────
  router.get('/avatars/:roomId', pollLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { chainId } = req.query;
      const avatars = await ServerStore.getAvatars(String(roomId), String(chainId || 43113));
      return res.json({ avatars });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /avatar ──────────────────────────────────────────
  router.post('/avatar', actionLimiter, async (req, res) => {
    try {
      const { roomId, address, avatar, signature, signerAddress, nonce, timestamp, chainId } = req.body;

      if (!roomId || !address || !avatar || !signature) {
        return res.status(400).json({ error: 'Missing req fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId),
        playerAddress: String(address),
        signature: String(signature) as `0x${string}`,
        signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('avatar', chainId, roomId).withAddress(address).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('avatar', chainId, roomId).withAddress(address).withModern(n, ts).build(),
      });

      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      if (!avatar.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Invalid avatar format' });
      }

      await ServerStore.storeAvatar(String(roomId), String(address), String(avatar), String(chainId || 43113));
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * routes/sessionRoutes.ts
 * POST /register-session  — cache session key local + Redis
 * GET  /health            — health check
 */
import { Router } from 'express';
import { verifyMessage, type Address } from 'viem';
import { recoverMessageAddress } from '../auth/verifySignature.js';
import { sessionCache } from '../stores/index.js';
import { getRedis } from '../redis.js';
import { GM_ADDRESS } from '../chain.js';
import { getAllNightStates } from '../game-state.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

export function createSessionRoutes(actionLimiter: RateLimitRequestHandler) {
  const router = Router();

  // ── Health ────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      gm: GM_ADDRESS,
      activeRooms: getAllNightStates().size,
      uptime: process.uptime(),
    });
  });

  // ── Register Session Key ──────────────────────────────────
  router.post('/register-session', actionLimiter, async (req, res) => {
    try {
      const { mainWallet, sessionAddress, roomId, signature, nonce, timestamp } = req.body;
      if (!mainWallet || !sessionAddress || !roomId || !signature) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const normalizedMain = mainWallet.toLowerCase();
      const normalizedSession = sessionAddress.toLowerCase();
      const roomNum = Number(roomId);
      const tsNum = Number(timestamp);
      const message = `register-session:${roomId}:${normalizedMain}:${normalizedSession}:${nonce}:${tsNum}`;

      let recoveredAddress: string;
      try {
        const raw = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
        recoveredAddress = raw.toLowerCase();
      } catch (e: any) {
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      if (recoveredAddress !== normalizedMain) {
        return res.status(401).json({ error: 'Only main wallet can authorize a session key' });
      }

      const valid = await verifyMessage({
        address: recoveredAddress as Address,
        message,
        signature: signature as `0x${string}`,
      });
      if (!valid) return res.status(401).json({ error: 'Invalid signature' });

      sessionCache.set(normalizedMain, { sessionAddress: normalizedSession, roomId: roomNum });

      const redis = getRedis();
      if (redis) {
        redis
          .set(
            `gm:session:${normalizedMain}`,
            JSON.stringify({ sessionAddress: normalizedSession, roomId: roomNum }),
            'EX',
            48 * 60 * 60,
          )
          .catch(() => {});
      }

      console.log(`[SESSION] Cached session for ${normalizedMain} → ${normalizedSession} (room ${roomNum})`);
      return res.json({ ok: true });
    } catch (e: any) {
      console.error('[SESSION] Error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}

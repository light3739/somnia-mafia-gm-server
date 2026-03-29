/**
 * routes/sessionRoutes.ts
 */
import { Router } from 'express';
import { verifyMessage, type Address } from 'viem';
import { recoverMessageAddress } from '../auth/verifySignature.js';
import type { GMStore } from '../stores/index.js';
import { GM_ADDRESS } from '../chain.js';
import { getAllNightStates } from '../game-state.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import type { RedisClient } from '../redis.js';

export interface SessionRoutesContext {
  store: GMStore;
  redis: RedisClient;
  actionLimiter: RateLimitRequestHandler;
}

export function createSessionRoutes(ctx: SessionRoutesContext) {
  const router = Router();
  const { store, redis, actionLimiter } = ctx;

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
      const { mainWallet, sessionAddress, roomId, signature, nonce, timestamp, chainId } = req.body;
      if (!mainWallet || !sessionAddress || !roomId || !signature || !chainId) {
        return res.status(400).json({ error: 'Missing req fields' });
      }

      const normalizedMain = mainWallet.toLowerCase();
      const normalizedSession = sessionAddress.toLowerCase();
      const roomNum = Number(roomId);
      const cidNum = Number(chainId);
      const tsNum = Number(timestamp);
      const message = `register-session:${cidNum}:${roomId}:${normalizedMain}:${normalizedSession}:${nonce}:${tsNum}`;

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

      // Injected store usage
      const cacheKey = `${cidNum}:${normalizedMain}`;
      store.sessionCache.set(cacheKey, { sessionAddress: normalizedSession, roomId: roomNum, chainId: cidNum });

      // Injected redis usage
      if (redis) {
        redis.set(
          `gm:session:${cacheKey}`,
          JSON.stringify({ sessionAddress: normalizedSession, roomId: roomNum, chainId: cidNum }),
          'EX',
          48 * 60 * 60,
        ).catch(() => {});
      }

      console.log(`[SESSION] Cached session for ${normalizedMain} → ${normalizedSession} (room ${roomNum})`);
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}

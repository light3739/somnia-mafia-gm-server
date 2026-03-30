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
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

import { logger } from '../utils/logger.js';

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
      const roomIdStr = String(roomId);
      const cidStr = String(chainId || 43113);
      
      const message = new SignatureBuilder('register-session', cidStr, roomIdStr)
        .withAddress(normalizedMain)
        .withAddress(normalizedSession)
        .withModern(nonce, Number(timestamp))
        .build();

      let recoveredAddress: string;
      try {
        const raw = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
        recoveredAddress = raw.toLowerCase();
      } catch (e: any) {
        logger.warn({ err: e.message, roomId: roomIdStr }, '[register-session] Signature recovery failed');
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      if (recoveredAddress !== normalizedMain) {
        logger.warn({ recovered: recoveredAddress, expected: normalizedMain }, '[register-session] Recovered address mismatch');
        return res.status(401).json({ error: 'Only main wallet can authorize a session key' });
      }

      const valid = await verifyMessage({
        address: recoveredAddress as Address,
        message,
        signature: signature as `0x${string}`,
      });
      if (!valid) {
        logger.warn({
          address: recoveredAddress,
          message,
          signature
        }, '[register-session] Invalid signature check');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Injected store usage
      const cacheKey = `${cidStr}:${normalizedMain}`;
      store.sessionCache.set(cacheKey, { sessionAddress: normalizedSession, roomId: roomIdStr, chainId: Number(cidStr) });

      // Injected redis usage
      if (redis) {
        redis.set(
          `gm:session:${cacheKey}`,
          JSON.stringify({ sessionAddress: normalizedSession, roomId: roomIdStr, chainId: Number(cidStr) }),
          'EX',
          48 * 60 * 60,
        ).catch((err) => {
          logger.error({ err, cacheKey }, '[register-session] Redis cache update failed');
        });
      }

      logger.info({ main: normalizedMain, session: normalizedSession, roomId: roomIdStr, chainId: cidStr }, '[SESSION] Session key registered');
      return res.json({ ok: true });
    } catch (e: any) {
      logger.error({ err: e.message, roomId: req.body?.roomId }, '[register-session] Internal error');
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}

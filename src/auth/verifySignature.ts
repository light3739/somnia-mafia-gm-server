/**
 * auth/verifySignature.ts
 */
import { verifyMessage, recoverMessageAddress, type Address } from 'viem';
import { getSessionKey } from '../chain.js';
import { logger } from '../utils/logger.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';
import { ServerStore } from '../services/serverStore.js';

export interface AuthContext {
  store: GMStore;
  redis: RedisClient;
}

export function createAuthService(ctx: AuthContext) {
  const { store, redis } = ctx;

  /**
   * Централизованная проверка подписей с поддержкой сессионных ключей.
   */
  async function verifyAuthorizedSignature(params: {
    roomId: string;
    signature: `0x${string}`;
    playerAddress: string;
    signerAddress?: string;
    buildLegacyMessage: () => string;
    buildModernMessage: (nonce: string, timestamp: number) => string;
    nonce?: string;
    timestamp?: number;
    chainId?: number;
    nonceScope?: string;
  }): Promise<{ ok: true; signer: string } | { ok: false; error: string; status: number }> {
    const {
      roomId, signature, playerAddress, signerAddress,
      buildLegacyMessage, buildModernMessage, nonce, timestamp, chainId,
    } = params;

    const normalizedPlayer = playerAddress.toLowerCase();
    const normalizedSigner = (signerAddress || playerAddress).toLowerCase();

    let valid = false;

    // 1. Modern signature logic (nonce + timestamp)
    if (nonce && timestamp !== undefined) {
      const tsNum = Number(timestamp);
      if (Number.isFinite(tsNum)) {
        const now = Date.now();
        const age = now - tsNum;
        if (age > 60_000 || age < -10_000) {
          return { ok: false, error: 'Timestamp expired or too far in future (max ±60s)', status: 401 };
        }

        // Build messages first, then verify BEFORE consuming nonce.
        // This prevents attackers from burning nonces with invalid signatures.
        const modernMsg = buildModernMessage(nonce, tsNum);
        const derivedAction = modernMsg.split(':')[0] || 'default';
        const scope = params.nonceScope || derivedAction;

        const legacy = buildLegacyMessage();
        const modern = buildModernMessage(nonce, tsNum);

        valid = await verifyMessage({
          address: normalizedSigner as Address,
          message: modern,
          signature,
        });

        if (!valid) {
          try {
            const recovered = await recoverMessageAddress({ message: modern, signature: signature as `0x${string}` });
            logger.warn({
              expectedSigner: normalizedSigner,
              recoveredSigner: recovered.toLowerCase(),
              message: modern,
              signature: signature.slice(0, 20) + '...',
              player: normalizedPlayer,
              roomId,
              chainId,
              nonce
            }, '[AUTH] Signature Verification Failed!');
          } catch (e: any) {
            logger.error({ err: e }, '[AUTH] Sig recovery failed');
          }
        }

        // Consume nonce ONLY after signature is verified valid
        if (valid) {
          const isFirstTime = await ServerStore.consumeReplayNonce(scope, roomId, normalizedSigner, nonce, undefined, chainId);
          if (!isFirstTime) {
            return { ok: false, error: 'Nonce already used (potential replay)', status: 401 };
          }
        }
      }
    }

    // 2. Legacy fallback (no nonce needed — old clients)
    if (!valid) {
      valid = await verifyMessage({
        address: normalizedPlayer as Address,
        message: buildLegacyMessage(),
        signature,
      });
      if (valid) return { ok: true, signer: normalizedPlayer };
    }

    if (!valid) return { ok: false, error: 'Invalid signature', status: 401 };

    // 3. Session key resolution (Signer vs Player)
    if (normalizedSigner !== normalizedPlayer) {
      const requestedRoomIdBI = BigInt(roomId);
      const effectiveChainId = Number(chainId || 50312);
      const cacheKey = `${effectiveChainId}:${normalizedPlayer}`;

      // a) Check local cache
      let cached = store.sessionCache.get(cacheKey);

      // b) Redis fallback
      if (!cached && redis) {
        try {
          const stored = await redis.get(`gm:session:${cacheKey}`);
          if (stored) {
            cached = JSON.parse(stored);
            if (cached) {
              store.sessionCache.set(cacheKey, cached);
            }
          }
        } catch { /* log fallback silently */ }
      }

      if (cached && cached.sessionAddress === normalizedSigner && cached.roomId != null && BigInt(cached.roomId) === requestedRoomIdBI && cached.chainId === effectiveChainId) {
        return { ok: true, signer: normalizedSigner };
      }

      // c) On-chain fallback with retry
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const session = await getSessionKey(normalizedPlayer as Address, effectiveChainId) as any;
          const sessionAddress = String(session.sessionAddress || '').toLowerCase();
          const isActive = Boolean(session.isActive);
          const sessionRoomIdBI = BigInt(session.roomId || 0n);
          const expiresAt = Number(session.expiresAt || 0);
          const isExpired = expiresAt > 0 && expiresAt < Math.floor(Date.now() / 1000);

          if (sessionAddress === normalizedSigner && isActive && !isExpired && sessionRoomIdBI === requestedRoomIdBI) {
            store.sessionCache.set(cacheKey, { sessionAddress: normalizedSigner, roomId: String(requestedRoomIdBI), chainId: effectiveChainId });
            return { ok: true, signer: normalizedSigner };
          }
          if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
        } catch (e: any) {
          if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
        }
      }

      return {
        ok: false,
        error: `Session key mismatch/stale on-chain. Received: ${normalizedSigner}. Please re-join.`,
        status: 403,
      };
    }

    return { ok: true, signer: normalizedSigner };
  }

  return { verifyAuthorizedSignature };
}

export { recoverMessageAddress };

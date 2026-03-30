/**
 * auth/verifySignature.ts
 */
import { verifyMessage, recoverMessageAddress, type Address } from 'viem';
import { getSessionKey } from '../chain.js';
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
        if (age > 300_000 || age < -30_000) {
          return { ok: false, error: 'Timestamp expired or too far in future (max ±5 min)', status: 401 };
        }

        const scope = params.nonceScope || 'default';
        const isFirstTime = await ServerStore.consumeReplayNonce(scope, roomId, normalizedSigner, nonce, undefined, chainId);
        if (!isFirstTime) {
          return { ok: false, error: 'Nonce already used (potential replay)', status: 401 };
        }

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
            console.log(`[AUTH-DEBUG] Modern Sig Fail. Signer: ${normalizedSigner}`);
            console.log(`[AUTH-DEBUG] Recovered: ${recovered.toLowerCase()}`);
            console.log(`[AUTH-DEBUG] Modern Message: "${modern}"`);
            console.log(`[AUTH-DEBUG] Legacy Message: "${legacy}"`);
            console.log(`[AUTH-DEBUG] Signature (prefix): ${signature?.slice(0, 10)}...`);
          } catch (e: any) {
            console.log(`[AUTH-DEBUG] Sig recovery failed: ${e.message}`);
          }
        }
      }
    }

    // 2. Legacy fallback
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
      const expectedRoomId = Number(BigInt(roomId));
      const effectiveChainId = Number(chainId || 43113);
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

      if (cached && cached.sessionAddress === normalizedSigner && cached.roomId === expectedRoomId && cached.chainId === effectiveChainId) {
        return { ok: true, signer: normalizedSigner };
      }

      // c) On-chain fallback with retry
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const session = await getSessionKey(normalizedPlayer as Address, effectiveChainId) as any;
          const sessionAddress = String(session.sessionAddress || '').toLowerCase();
          const isActive = Boolean(session.isActive);
          const sessionRoomId = Number(session.roomId || 0);

          if (sessionAddress === normalizedSigner && isActive && sessionRoomId === expectedRoomId) {
            store.sessionCache.set(cacheKey, { sessionAddress: normalizedSigner, roomId: expectedRoomId, chainId: effectiveChainId });
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

/**
 * auth/verifySignature.ts
 * Central signature verification: modern (nonce+ts) + legacy formats.
 * Also handles session key resolution (local cache → Redis → on-chain).
 */
import { verifyMessage, recoverMessageAddress, type Address } from 'viem';
import { getSessionKey } from '../chain.js';
import { sessionCache } from '../stores/index.js';
import { getRedis } from '../redis.js';
import { ServerStore } from '../services/serverStore.js';

export async function verifyAuthorizedSignature(params: {
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

  // 1. Try modern signature (nonce + timestamp)
  if (nonce && timestamp !== undefined) {
    const tsNum = Number(timestamp);
    if (Number.isFinite(tsNum)) {
      const now = Date.now();
      const age = now - tsNum;
      if (age > 300000 || age < -30000) {
        return { ok: false, error: 'Timestamp expired or too far in future (max ±5 min)', status: 401 };
      }

      const scope = params.nonceScope || 'default';
      const isFirstTime = await ServerStore.consumeReplayNonce(scope, roomId, normalizedSigner, nonce);
      if (!isFirstTime) {
        return { ok: false, error: 'Nonce already used (potential replay)', status: 401 };
      }

      valid = await verifyMessage({
        address: normalizedSigner as Address,
        message: buildModernMessage(nonce, tsNum),
        signature,
      });
    }
  }

  // 2. Fallback to legacy format
  if (!valid) {
    valid = await verifyMessage({
      address: normalizedPlayer as Address,
      message: buildLegacyMessage(),
      signature,
    });
    if (valid) return { ok: true, signer: normalizedPlayer };
  }

  if (!valid) {
    return { ok: false, error: 'Invalid signature', status: 401 };
  }

  // 3. If session key used, verify it belongs to the main wallet
  if (normalizedSigner !== normalizedPlayer) {
    const expectedRoomId = Number(BigInt(roomId));

    // a) Local cache
    let cached = sessionCache.get(normalizedPlayer);

    // b) Redis fallback
    if (!cached) {
      const redis = getRedis();
      if (redis) {
        try {
          const stored = await redis.get(`gm:session:${normalizedPlayer}`);
          if (stored) {
            cached = JSON.parse(stored);
            if (cached) {
              sessionCache.set(normalizedPlayer, cached);
              console.log(`[AUTH] Restored session for ${normalizedPlayer} from Redis`);
            }
          }
        } catch {
          console.warn(`[AUTH] Redis fetch failed for ${normalizedPlayer}`);
        }
      }
    }

    if (cached && cached.sessionAddress === normalizedSigner && cached.roomId === expectedRoomId) {
      return { ok: true, signer: normalizedSigner };
    }

    // c) On-chain fallback with retry
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const session = await getSessionKey(normalizedPlayer as Address, chainId) as any;
        const sessionAddress = String(session.sessionAddress || '').toLowerCase();
        const isActive = Boolean(session.isActive);
        const sessionRoomId = Number(session.roomId || 0);

        if (sessionAddress === normalizedSigner && isActive && sessionRoomId === expectedRoomId) {
          sessionCache.set(normalizedPlayer, { sessionAddress: normalizedSigner, roomId: expectedRoomId });
          return { ok: true, signer: normalizedSigner };
        }

        console.warn(`[AUTH] Session mismatch (attempt ${attempt + 1})`, {
          player: normalizedPlayer, onChain: sessionAddress, received: normalizedSigner,
          room: expectedRoomId, onChainRoom: sessionRoomId, active: isActive,
        });
        if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
      } catch (e: any) {
        console.warn(`[AUTH] Session lookup failed (attempt ${attempt + 1}): ${e.message}`);
        if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
      }
    }

    return {
      ok: false,
      error: `Session key mismatch/stale on-chain. Received: ${normalizedSigner}. Please re-join to sync.`,
      status: 403,
    };
  }

  return { ok: true, signer: normalizedSigner };
}

/** Used by /register-session — recovers address from signature directly. */
export { recoverMessageAddress };

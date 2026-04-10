/**
 * auth.test.ts — Tests for signature verification and replay protection.
 *
 * Verifies the critical security fix: nonce is consumed AFTER signature
 * validation, not before. Also tests session key resolution, timestamp
 * windows, and legacy fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthService } from '../src/auth/verifySignature.js';
import { SignatureBuilder } from '../src/auth/SignatureBuilder.js';
import { GMStore } from '../src/stores/index.js';
import { ServerStore } from '../src/services/serverStore.js';

// ---- Mock viem ----
vi.mock('viem', () => ({
  verifyMessage: vi.fn(),
  recoverMessageAddress: vi.fn(),
}));

// ---- Mock chain (on-chain session key lookup) ----
vi.mock('../src/chain.js', () => ({
  getSessionKey: vi.fn(),
}));

// ---- Mock ServerStore.consumeReplayNonce ----
vi.mock('../src/services/serverStore.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    ServerStore: {
      ...original.ServerStore,
      consumeReplayNonce: vi.fn().mockResolvedValue(true),
    },
  };
});

// Import mocked modules
const { verifyMessage, recoverMessageAddress } = await import('viem');
const { getSessionKey } = await import('../src/chain.js');

// ================================================================
// SIGNATURE BUILDER
// ================================================================

describe('SignatureBuilder', () => {
  it('builds base message: action:chainId:roomId', () => {
    const msg = new SignatureBuilder('night', 50312, '42').build();
    expect(msg).toBe('night:50312:42');
  });

  it('appends address params (lowercased)', () => {
    const msg = new SignatureBuilder('night', 50312, '42')
      .withAddress('0xABCDEF')
      .build();
    expect(msg).toBe('night:50312:42:0xabcdef');
  });

  it('appends generic params (case preserved)', () => {
    const msg = new SignatureBuilder('night', 50312, '42')
      .withParam('kill')
      .withAddress('0xABC')
      .build();
    expect(msg).toBe('night:50312:42:kill:0xabc');
  });

  it('appends modern replay protection', () => {
    const msg = new SignatureBuilder('register-session', '50312', '42')
      .withAddress('0xmain')
      .withAddress('0xsession')
      .withModern('nonce123', 1700000000)
      .build();
    expect(msg).toBe('register-session:50312:42:0xmain:0xsession:nonce123:1700000000');
  });

  it('defaults chainId to 50312 when undefined', () => {
    const msg = new SignatureBuilder('test', undefined, '1').build();
    expect(msg).toBe('test:50312:1');
  });
});

// ================================================================
// VERIFY AUTHORIZED SIGNATURE
// ================================================================

describe('verifyAuthorizedSignature', () => {
  let store: GMStore;
  let authService: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    store = new GMStore();
    authService = createAuthService({ store, redis: null as any });
    vi.clearAllMocks();
  });

  // ---- Nonce ordering (security fix A1) ----

  describe('Nonce consumption ordering', () => {
    it('does NOT consume nonce when signature is invalid', async () => {
      (verifyMessage as any).mockResolvedValue(false);
      (recoverMessageAddress as any).mockResolvedValue('0xwrong');

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xfakesig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `modern:${n}:${ts}`,
        nonce: 'nonce1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(false);
      // Nonce should NOT have been consumed because sig was invalid
      expect(ServerStore.consumeReplayNonce).not.toHaveBeenCalled();
    });

    it('consumes nonce AFTER valid signature', async () => {
      (verifyMessage as any).mockResolvedValue(true);

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xvalidsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `modern:${n}:${ts}`,
        nonce: 'nonce1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(true);
      expect(ServerStore.consumeReplayNonce).toHaveBeenCalledTimes(1);
    });

    it('rejects replay (nonce already used) after valid sig', async () => {
      (verifyMessage as any).mockResolvedValue(true);
      (ServerStore.consumeReplayNonce as any).mockResolvedValue(false); // already used

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xvalidsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `modern:${n}:${ts}`,
        nonce: 'used_nonce',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Nonce already used');
    });
  });

  // ---- Timestamp validation ----

  describe('Timestamp validation', () => {
    it('rejects expired timestamp (>60s ago)', async () => {
      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now() - 120_000, // 2 min ago
        chainId: 50312,
      });

      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Timestamp expired');
    });

    it('rejects future timestamp (>10s ahead)', async () => {
      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now() + 30_000, // 30s in future
        chainId: 50312,
      });

      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Timestamp expired');
    });

    it('accepts timestamp within +-60s window', async () => {
      (verifyMessage as any).mockResolvedValue(true);
      (ServerStore.consumeReplayNonce as any).mockResolvedValue(true);

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now() - 30_000, // 30s ago, within window
        chainId: 50312,
      });

      expect(result.ok).toBe(true);
    });
  });

  // ---- Legacy fallback ----

  describe('Legacy signature fallback', () => {
    it('falls back to legacy when modern sig fails', async () => {
      // Modern sig fails, legacy succeeds
      (verifyMessage as any)
        .mockResolvedValueOnce(false)   // modern check
        .mockResolvedValueOnce(true);   // legacy check
      (recoverMessageAddress as any).mockResolvedValue('0xplayer');

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy-msg',
        buildModernMessage: (n, ts) => `modern:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(true);
      expect((result as any).signer).toBe('0xplayer');
    });

    it('returns error when both modern and legacy fail', async () => {
      (verifyMessage as any).mockResolvedValue(false);
      (recoverMessageAddress as any).mockResolvedValue('0xwrong');

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        buildLegacyMessage: () => 'legacy-msg',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Invalid signature');
    });
  });

  // ---- Session key resolution ----

  describe('Session key resolution', () => {
    it('resolves session key from local cache', async () => {
      (verifyMessage as any).mockResolvedValue(true);
      (ServerStore.consumeReplayNonce as any).mockResolvedValue(true);

      // Cache the session mapping
      store.sessionCache.set('50312:0xplayer', {
        sessionAddress: '0xsession',
        roomId: '1',
        chainId: 50312,
      });

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xsession',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(true);
      expect((result as any).signer).toBe('0xsession');
      // Should NOT call on-chain lookup
      expect(getSessionKey).not.toHaveBeenCalled();
    });

    it('falls back to on-chain lookup when cache misses', async () => {
      (verifyMessage as any).mockResolvedValue(true);
      (ServerStore.consumeReplayNonce as any).mockResolvedValue(true);
      (getSessionKey as any).mockResolvedValue({
        sessionAddress: '0xsession',
        isActive: true,
        roomId: 1n,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xsession',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(true);
      expect(getSessionKey).toHaveBeenCalled();
      // Verify cache was populated
      expect(store.sessionCache.has('50312:0xplayer')).toBe(true);
    });

    it('rejects mismatched session key after on-chain lookup', async () => {
      (verifyMessage as any).mockResolvedValue(true);
      (ServerStore.consumeReplayNonce as any).mockResolvedValue(true);
      (getSessionKey as any).mockResolvedValue({
        sessionAddress: '0xDIFFERENT',
        isActive: true,
        roomId: 1n,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      const result = await authService.verifyAuthorizedSignature({
        roomId: '1',
        signature: '0xsig' as `0x${string}`,
        playerAddress: '0xplayer',
        signerAddress: '0xsession',
        buildLegacyMessage: () => 'legacy',
        buildModernMessage: (n, ts) => `m:${n}:${ts}`,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: 50312,
      });

      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('Session key mismatch');
    }, 15_000); // Long timeout for 5 retries × 2s
  });
});

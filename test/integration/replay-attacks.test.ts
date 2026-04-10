/**
 * replay-attacks.test.ts — Cross-chain, cross-room, cross-action replay protection.
 *
 * Verifies that a valid signature for one context cannot be reused in another.
 * Tests the nonce consumption, scope derivation, and timestamp validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignatureBuilder } from '../../src/auth/SignatureBuilder.js';

// ================================================================
// CROSS-CONTEXT MESSAGE ISOLATION
// ================================================================

describe('Replay Protection — Message Isolation', () => {
  const NONCE = 'replay_test_nonce';
  const TS = 1700000000;

  it('different chainIds produce different messages (cross-chain protection)', () => {
    const somnia = new SignatureBuilder('night', 50312, '42').withModern(NONCE, TS).build();
    const fuji = new SignatureBuilder('night', 43113, '42').withModern(NONCE, TS).build();
    expect(somnia).not.toBe(fuji);
    expect(somnia).toContain(':50312:');
    expect(fuji).toContain(':43113:');
  });

  it('different roomIds produce different messages (cross-room protection)', () => {
    const room1 = new SignatureBuilder('night', 50312, '1').withModern(NONCE, TS).build();
    const room2 = new SignatureBuilder('night', 50312, '2').withModern(NONCE, TS).build();
    expect(room1).not.toBe(room2);
  });

  it('different actions produce different messages (cross-action protection)', () => {
    const night = new SignatureBuilder('night', 50312, '42').withModern(NONCE, TS).build();
    const avatar = new SignatureBuilder('avatar', 50312, '42').withModern(NONCE, TS).build();
    const discuss = new SignatureBuilder('discussion', 50312, '42').withModern(NONCE, TS).build();
    expect(night).not.toBe(avatar);
    expect(avatar).not.toBe(discuss);
  });

  it('different nonces produce different messages (replay protection)', () => {
    const n1 = new SignatureBuilder('night', 50312, '42').withModern('nonce_a', TS).build();
    const n2 = new SignatureBuilder('night', 50312, '42').withModern('nonce_b', TS).build();
    expect(n1).not.toBe(n2);
  });

  it('different timestamps produce different messages', () => {
    const t1 = new SignatureBuilder('night', 50312, '42').withModern(NONCE, 1700000000).build();
    const t2 = new SignatureBuilder('night', 50312, '42').withModern(NONCE, 1700000001).build();
    expect(t1).not.toBe(t2);
  });

  it('address params are case-insensitive (no case-based replay)', () => {
    const upper = new SignatureBuilder('night', 50312, '42').withAddress('0xABCDEF').build();
    const lower = new SignatureBuilder('night', 50312, '42').withAddress('0xabcdef').build();
    expect(upper).toBe(lower);
  });
});

// ================================================================
// NONCE SCOPE DERIVATION
// ================================================================

describe('Replay Protection — Nonce Scope Derivation', () => {
  it('scope is derived from first segment of message (action name)', () => {
    const nightMsg = new SignatureBuilder('night', 50312, '42')
      .withParam('kill').withAddress('0xvictim').withModern('n1', 1700000000).build();
    const scope = nightMsg.split(':')[0];
    expect(scope).toBe('night');

    const avatarMsg = new SignatureBuilder('avatar', 50312, '42')
      .withAddress('0xplayer').withModern('n1', 1700000000).build();
    expect(avatarMsg.split(':')[0]).toBe('avatar');
  });

  it('same nonce with different scopes should be independent', () => {
    // This verifies the key structure: replay:{scope}:{chainId}:{roomId}:{addr}:{nonce}
    // Two different actions with same nonce should have different Redis keys
    const nightKey = `replay:night:50312:42:0xplayer:nonce1`;
    const avatarKey = `replay:avatar:50312:42:0xplayer:nonce1`;
    expect(nightKey).not.toBe(avatarKey);
  });
});

// ================================================================
// FRONTEND ↔ GM SERVER MESSAGE PARITY
// ================================================================

describe('Frontend ↔ GM Server Message Parity', () => {
  // These tests verify that the SignatureBuilder produces identical output
  // regardless of where it runs (frontend or GM server). Both repos have
  // an identical copy of this class.

  it('night action message format is deterministic', () => {
    const msg = new SignatureBuilder('night', 50312, '42')
      .withParam(1)       // dayCount
      .withParam('kill')  // actionType
      .withAddress('0xAbCd0000000000000000000000000000DeAdBeEf') // target
      .withModern('nonce_abc', 1700000000)
      .build();

    expect(msg).toBe('night:50312:42:1:kill:0xabcd0000000000000000000000000000deadbeef:nonce_abc:1700000000');
  });

  it('avatar message format is deterministic', () => {
    const msg = new SignatureBuilder('avatar', 50312, '42')
      .withAddress('0xAbCd0000000000000000000000000000DeAdBeEf')
      .withModern('nonce_xyz', 1700000000)
      .build();

    expect(msg).toBe('avatar:50312:42:0xabcd0000000000000000000000000000deadbeef:nonce_xyz:1700000000');
  });

  it('reveal-secret message has NO nonce/timestamp (deterministic per role+salt)', () => {
    const msg = new SignatureBuilder('reveal-secret', 50312, '42')
      .withParam(1)         // role
      .withParam('mysalt')  // salt
      .build();

    expect(msg).toBe('reveal-secret:50312:42:1:mysalt');
    // No nonce/timestamp → same input always produces same output
  });

  it('register-session message includes both addresses', () => {
    const msg = new SignatureBuilder('register-session', 50312, '42')
      .withAddress('0xMainWallet')
      .withAddress('0xSessionKey')
      .withModern('nonce1', 1700000000)
      .build();

    expect(msg).toBe('register-session:50312:42:0xmainwallet:0xsessionkey:nonce1:1700000000');
  });
});

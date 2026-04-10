/**
 * privacy.test.ts — Role secrecy and information leak prevention.
 *
 * Verifies that roles cannot be discovered through any endpoint
 * outside of the intended game phase. A single role leak can
 * compromise an entire game.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/createTestApp.js';
import { Role } from '../../src/types/contract.js';

// Mock chain + ecies
vi.mock('../../src/chain.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    getRoom: vi.fn(),
    getPlayers: vi.fn(),
    getChainConfig: vi.fn().mockReturnValue({ rpc: 'http://localhost' }),
    hasCommittedRole: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../../src/ecies.js', () => ({
  eciesEncrypt: vi.fn().mockReturnValue('encrypted_role_blob'),
}));

const { getRoom } = await import('../../src/chain.js');

const CID = 50312;
const ROOM = '42';
const ROOM_KEY = `${CID}:${ROOM}`;
const MAFIA = '0xmafia';
const DOCTOR = '0xdoctor';
const DETECTIVE = '0xdetective';
const CITIZEN = '0xcitizen';

function makeRoles() {
  return new Map<string, Role>([
    [MAFIA, Role.MAFIA],
    [DOCTOR, Role.DOCTOR],
    [DETECTIVE, Role.DETECTIVE],
    [CITIZEN, Role.CITIZEN],
  ]);
}

function q(addr: string) {
  return {
    playerAddress: addr,
    signature: '0xsig',
    signerAddress: addr,
    nonce: 'n1',
    timestamp: String(Date.now()),
    chainId: String(CID),
  };
}

// ================================================================
// /my-role — ROLE ACCESS
// ================================================================

describe('GET /my-role/:roomId — Role Access Control', () => {
  it('returns encrypted role for valid player with resolved roles', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: DOCTOR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });
    // Must have ECIES pubkey registered
    store.getRoomMap(store.eciesPubkeys, ROOM_KEY).set(DOCTOR, '0xpubkey_hex');

    const res = await request(app)
      .get(`/my-role/${ROOM}`)
      .query(q(DOCTOR));

    expect(res.status).toBe(200);
    expect(res.body.encrypted).toBeDefined();
    expect(res.body.roleId).toBe(Role.DOCTOR);
  });

  it('returns 202 pending when roles not yet resolved', async () => {
    const { app, store } = createTestApp({ autoAuthSigner: DOCTOR });
    store.getRoomMap(store.eciesPubkeys, ROOM_KEY).set(DOCTOR, '0xpubkey_hex');

    const res = await request(app)
      .get(`/my-role/${ROOM}`)
      .query(q(DOCTOR));

    expect(res.status).toBe(202);
    expect(res.body.pending).toBe(true);
  });

  it('returns 404 when ECIES pubkey missing', async () => {
    const { app } = createTestApp({
      autoAuthSigner: DOCTOR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });
    // No pubkey registered

    const res = await request(app)
      .get(`/my-role/${ROOM}`)
      .query(q(DOCTOR));

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('pubkey');
  });

  it('player can only see their OWN role (not others)', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: DOCTOR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });
    store.getRoomMap(store.eciesPubkeys, ROOM_KEY).set(DOCTOR, '0xpubkey_hex');

    const res = await request(app)
      .get(`/my-role/${ROOM}`)
      .query(q(DOCTOR));

    // Returns ONLY Doctor's role, not Mafia's
    expect(res.body.roleId).toBe(Role.DOCTOR);
    expect(res.body.members).toBeUndefined(); // no member list
  });
});

// ================================================================
// /room-roles — PUBLIC ROLE REVEAL (ENDED only)
// ================================================================

describe('GET /room-roles/:roomId — Post-Game Role Reveal', () => {
  it('returns 202 during LOBBY phase', async () => {
    (getRoom as any).mockResolvedValue({ phase: 0 });
    const { app } = createTestApp({
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/room-roles/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(202);
  });

  it('returns 202 during DAY phase', async () => {
    (getRoom as any).mockResolvedValue({ phase: 3 });
    const { app } = createTestApp({
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/room-roles/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(202);
  });

  it('returns 202 during NIGHT phase', async () => {
    (getRoom as any).mockResolvedValue({ phase: 5 });
    const { app } = createTestApp({
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/room-roles/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(202);
  });

  it('returns all roles ONLY after ENDED (phase 6)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 6 });
    const { app } = createTestApp({
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/room-roles/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.roles[MAFIA]).toBe('MAFIA');
    expect(res.body.roles[DOCTOR]).toBe('DOCTOR');
    expect(res.body.roles[DETECTIVE]).toBe('DETECTIVE');
    expect(res.body.roles[CITIZEN]).toBe('CIVILIAN');
  });

  it('does NOT require authentication (public after game ends)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 6 });
    const { app } = createTestApp({
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    // No signature, no playerAddress — just roomId + chainId
    const res = await request(app)
      .get(`/room-roles/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
  });
});

// ================================================================
// /mafia-members — ROLE-GATED ACCESS
// ================================================================

describe('GET /mafia-members/:roomId — Role-Based Access', () => {
  beforeEach(() => {
    (getRoom as any).mockResolvedValue({ phase: 5 }); // NIGHT
  });

  it('DOCTOR cannot see mafia members', async () => {
    const { app } = createTestApp({
      autoAuthSigner: DOCTOR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM}`)
      .query(q(DOCTOR));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Mafia');
  });

  it('DETECTIVE cannot see mafia members', async () => {
    const { app } = createTestApp({
      autoAuthSigner: DETECTIVE,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM}`)
      .query(q(DETECTIVE));

    expect(res.status).toBe(403);
  });

  it('CITIZEN cannot see mafia members', async () => {
    const { app } = createTestApp({
      autoAuthSigner: CITIZEN,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM}`)
      .query(q(CITIZEN));

    expect(res.status).toBe(403);
  });

  it('MAFIA can see all mafia members during NIGHT', async () => {
    const { app } = createTestApp({
      autoAuthSigner: MAFIA,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM}`)
      .query(q(MAFIA));

    expect(res.status).toBe(200);
    expect(res.body.members).toContain(MAFIA);
  });
});

// ================================================================
// /investigation-proof — DETECTIVE-ONLY ACCESS
// ================================================================

describe('POST /investigation-proof — Detective Access', () => {
  it('detective can get investigation result for their target', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: DETECTIVE,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    // Simulate: detective checked MAFIA during night
    store.getRoomMap(store.investigationProofs, ROOM_KEY).set(DETECTIVE, {
      targetAddress: MAFIA as any,
      timestamp: Date.now(),
    });

    const res = await request(app)
      .post('/investigation-proof')
      .send({
        roomId: ROOM,
        detectiveAddress: DETECTIVE,
        targetAddress: MAFIA,
        dayCount: 1,
        signature: '0xsig',
        signerAddress: DETECTIVE,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe(Role.MAFIA);
  });

  it('detective cannot get result for a target they did NOT investigate', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: DETECTIVE,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    // Detective investigated MAFIA, but asks for DOCTOR
    store.getRoomMap(store.investigationProofs, ROOM_KEY).set(DETECTIVE, {
      targetAddress: MAFIA as any,
      timestamp: Date.now(),
    });

    const res = await request(app)
      .post('/investigation-proof')
      .send({
        roomId: ROOM,
        detectiveAddress: DETECTIVE,
        targetAddress: DOCTOR, // Wrong target
        dayCount: 1,
        signature: '0xsig',
        signerAddress: DETECTIVE,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(404);
  });

  it('non-detective cannot access investigation results', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: CITIZEN,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .post('/investigation-proof')
      .send({
        roomId: ROOM,
        detectiveAddress: CITIZEN, // Not a detective
        targetAddress: MAFIA,
        dayCount: 1,
        signature: '0xsig',
        signerAddress: CITIZEN,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    // No proof exists for CITIZEN → 404
    expect(res.status).toBe(404);
  });
});

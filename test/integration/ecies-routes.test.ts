/**
 * ecies-routes integration tests.
 *
 * Tests the /mafia-members endpoint phase gate (security fix A2)
 * through the full HTTP stack: request → auth → phase check → store → response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/createTestApp.js';
import { Role } from '../../src/types/contract.js';

// Mock chain calls
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

const { getRoom, getPlayers } = await import('../../src/chain.js');

// ================================================================
// /mafia-members PHASE GATE (Fix A2)
// ================================================================

describe('GET /mafia-members/:roomId — phase gate', () => {
  const CHAIN_ID = 50312;
  const ROOM_ID = '42';
  const MAFIA_ADDR = '0xmafia1';
  const MAFIA_ADDR2 = '0xmafia2';
  const ROOM_KEY = `${CHAIN_ID}:${ROOM_ID}`;

  function makeRoles() {
    const roles = new Map<string, Role>();
    roles.set(MAFIA_ADDR, Role.MAFIA);
    roles.set(MAFIA_ADDR2, Role.MAFIA);
    roles.set('0xdoctor', Role.DOCTOR);
    roles.set('0xcitizen', Role.CITIZEN);
    return roles;
  }

  function makeQuery(playerAddress = MAFIA_ADDR) {
    return {
      playerAddress,
      signature: '0xfakesig',
      signerAddress: playerAddress,
      nonce: 'n1',
      timestamp: String(Date.now()),
      chainId: String(CHAIN_ID),
    };
  }

  it('returns 403 during LOBBY phase (phase 0)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 0 });
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_ADDR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('NIGHT');
  });

  it('returns 403 during DAY phase (phase 3)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 3 });
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_ADDR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(403);
  });

  it('returns 403 during VOTING phase (phase 4)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 4 });
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_ADDR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(403);
  });

  it('returns 200 with members during NIGHT phase (phase 5)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 5 });
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_ADDR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(200);
    expect(res.body.members).toContain(MAFIA_ADDR);
    expect(res.body.members).toContain(MAFIA_ADDR2);
    expect(res.body.members).toHaveLength(2);
  });

  it('returns 200 during ENDED phase (phase 6)', async () => {
    (getRoom as any).mockResolvedValue({ phase: 6 });
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_ADDR,
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
  });

  it('returns 403 if requester is not MAFIA', async () => {
    (getRoom as any).mockResolvedValue({ phase: 5 });
    const { app } = createTestApp({
      autoAuthSigner: '0xdoctor',
      roles: { roomKey: ROOM_KEY, roles: makeRoles() },
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery('0xdoctor'));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Mafia');
  });

  it('returns 202 if roles not yet resolved', async () => {
    (getRoom as any).mockResolvedValue({ phase: 5 });
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_ADDR,
      // No roles pre-populated
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(202);
    expect(res.body.pending).toBe(true);
  });

  it('returns 401 when auth fails', async () => {
    (getRoom as any).mockResolvedValue({ phase: 5 });
    const { app } = createTestApp({
      // No autoAuthSigner → auth fails
    });

    const res = await request(app)
      .get(`/mafia-members/${ROOM_ID}`)
      .query(makeQuery());

    expect(res.status).toBe(401);
  });
});

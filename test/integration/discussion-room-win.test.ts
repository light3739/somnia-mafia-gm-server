/**
 * discussion-room-win.test.ts — Discussion speaker turns, room passwords,
 * and win route edge cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/createTestApp.js';
import { Role, FLAGS } from '../../src/types/contract.js';

// Mock chain
vi.mock('../../src/chain.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    getRoom: vi.fn(),
    getPlayers: vi.fn(),
    getChainConfig: vi.fn().mockReturnValue({ rpc: 'http://localhost' }),
    hasCommittedRole: vi.fn().mockResolvedValue(true),
    signJoinPermit: vi.fn().mockResolvedValue('0xsignedpermit'),
    getTournament: vi.fn().mockResolvedValue({ phase: 0, buyIn: 0n }),
    isTournamentParticipant: vi.fn().mockResolvedValue(false),
    somniaTestnet: { id: 50312 },
    FLAGS: original.FLAGS,
    GamePhase: original.GamePhase,
  };
});

// Mock redis
vi.mock('../../src/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
  rPersistNightState: vi.fn(),
  rDeleteNightState: vi.fn(),
  rPersistRole: vi.fn(),
}));

// Mock ServerStore methods
vi.mock('../../src/services/serverStore.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  const discussionStates = new Map<string, unknown>();
  return {
    ...original,
    ServerStore: {
      ...original.ServerStore,
      consumeReplayNonce: vi.fn().mockResolvedValue(true),
      getDiscussionState: vi.fn(async (roomId: string, dayCount: number, chainId: number) => {
        return discussionStates.get(`${chainId}:${roomId}:${dayCount}`) || null;
      }),
      setDiscussionState: vi.fn(async (roomId: string, dayCount: number, state: unknown, chainId: number) => {
        discussionStates.set(`${chainId}:${roomId}:${dayCount}`, state);
      }),
      storeAvatar: vi.fn(),
      getAvatars: vi.fn().mockResolvedValue({}),
      getSecrets: vi.fn().mockResolvedValue({}),
      storeSecret: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
});

// Mock wsManager
vi.mock('../../src/ws/wsManager.js', () => ({
  wsManager: {
    broadcastToRoom: vi.fn(),
  },
}));

// Mock ecies
vi.mock('../../src/ecies.js', () => ({
  eciesEncrypt: vi.fn().mockReturnValue('encrypted_blob'),
}));

const { getRoom, getPlayers } = await import('../../src/chain.js');

const CID = 50312;
const ROOM = '42';
const HOST = '0xhost';
const PLAYER1 = '0xplayer1';
const PLAYER2 = '0xplayer2';

// ================================================================
// DISCUSSION ROUTES
// ================================================================

describe('GET /discussion — Speaker Turns', () => {
  it('returns inactive when discussion not started', async () => {
    const { app } = createTestApp({});

    const res = await request(app)
      .get('/discussion')
      .query({ roomId: ROOM, dayCount: '1', chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it('returns 400 without roomId', async () => {
    const { app } = createTestApp({});

    const res = await request(app)
      .get('/discussion')
      .query({});

    expect(res.status).toBe(400);
  });
});

describe('POST /discussion — Start/Skip Speaker', () => {
  beforeEach(() => {
    (getRoom as any).mockResolvedValue({ phase: 3, host: HOST }); // DAY
    (getPlayers as any).mockResolvedValue([
      { wallet: HOST, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
      { wallet: PLAYER1, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
      { wallet: PLAYER2, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    ]);
  });

  it('starts discussion with valid auth', async () => {
    const { app } = createTestApp({ autoAuthSigner: HOST });

    const res = await request(app)
      .post('/discussion')
      .send({
        roomId: ROOM,
        dayCount: 1,
        action: 'start',
        playerAddress: HOST,
        signature: '0xsig',
        signerAddress: HOST,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(200);
  });

  it('rejects discussion without auth', async () => {
    const { app } = createTestApp({});

    const res = await request(app)
      .post('/discussion')
      .send({
        roomId: ROOM,
        dayCount: 1,
        action: 'start',
        playerAddress: HOST,
        signature: '0xsig',
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(401);
  });
});

// ================================================================
// ROOM PASSWORD ROUTES
// ================================================================

describe('POST /room-password — Set Room Password', () => {
  beforeEach(() => {
    (getRoom as any).mockResolvedValue({ host: HOST, tournamentId: 0n });
  });

  it('host can set room password', async () => {
    const { app } = createTestApp({ autoAuthSigner: HOST });

    const res = await request(app)
      .post('/room-password')
      .send({
        roomId: ROOM,
        password: 'secret123',
        hostAddress: HOST,
        signature: '0xsig',
        signerAddress: HOST,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('non-host cannot set room password', async () => {
    const { app } = createTestApp({ autoAuthSigner: PLAYER1 });

    const res = await request(app)
      .post('/room-password')
      .send({
        roomId: ROOM,
        password: 'secret123',
        hostAddress: PLAYER1,
        signature: '0xsig',
        signerAddress: PLAYER1,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host');
  });

  it('rejects missing fields', async () => {
    const { app } = createTestApp({ autoAuthSigner: HOST });

    const res = await request(app)
      .post('/room-password')
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
  });
});

// ================================================================
// CROSS-ROUTE CONSISTENCY
// ================================================================

describe('Cross-Route Security', () => {
  it('auth failure is consistent across all protected routes', async () => {
    const { app } = createTestApp({}); // no auto-auth

    const routes = [
      { method: 'post', path: '/night-action', body: { roomId: ROOM, playerAddress: PLAYER1, actionType: 'kill', targetAddress: PLAYER2, signature: '0xsig' } },
      { method: 'post', path: '/avatar', body: { roomId: ROOM, address: PLAYER1, avatar: 'data:image/jpeg;base64,AA==', signature: '0xsig' } },
      { method: 'post', path: '/room-password', body: { roomId: ROOM, password: 'x', hostAddress: HOST, signature: '0xsig' } },
      { method: 'post', path: '/discussion', body: { roomId: ROOM, dayCount: 1, action: 'start', playerAddress: HOST, signature: '0xsig' } },
    ];

    for (const route of routes) {
      const res = await (request(app) as any)[route.method](route.path).send(route.body);
      expect(res.status).toBe(401, `Expected 401 for ${route.method.toUpperCase()} ${route.path}`);
    }
  });

  it('missing signature field returns 400 for action routes', async () => {
    const { app } = createTestApp({ autoAuthSigner: PLAYER1 });

    // night-action without signature
    const res = await request(app)
      .post('/night-action')
      .send({ roomId: ROOM, playerAddress: PLAYER1, actionType: 'kill', targetAddress: PLAYER2 });

    expect(res.status).toBe(400);
  });
});

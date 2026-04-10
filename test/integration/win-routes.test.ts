/**
 * win-routes.test.ts — Win detection, role secret submission, room join flow.
 *
 * Tests the complete end-game pipeline: win-check → submit secrets →
 * reveal roles on-chain. Also tests room join with password verification.
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
    signJoinPermit: vi.fn().mockResolvedValue('0xpermit_signature_65bytes'),
    getTournament: vi.fn().mockResolvedValue({ phase: 0, buyIn: 0n }),
    isTournamentParticipant: vi.fn().mockResolvedValue(false),
    somniaTestnet: { id: 50312 },
    FLAGS: original.FLAGS,
    GamePhase: original.GamePhase,
    revealRolesOnChain: vi.fn().mockResolvedValue({ hash: '0xtxhash' }),
    reportRoomGasCost: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../src/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/services/serverStore.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  const secrets = new Map<string, Record<string, unknown>>();
  return {
    ...original,
    ServerStore: {
      ...original.ServerStore,
      consumeReplayNonce: vi.fn().mockResolvedValue(true),
      storeSecret: vi.fn(async (roomId: string, addr: string, role: number, salt: string, commitment: string, chainId: unknown) => {
        const key = `${chainId || 50312}:${roomId}`;
        const existing = secrets.get(key) || {};
        existing[addr.toLowerCase()] = { role, salt, commitment };
        secrets.set(key, existing);
        return { ok: true };
      }),
      getRoomSecrets: vi.fn(async (roomId: string, chainId: unknown) => {
        return secrets.get(`${chainId || 50312}:${roomId}`) || null;
      }),
      storeAvatar: vi.fn(),
      getAvatars: vi.fn().mockResolvedValue({}),
      getDiscussionState: vi.fn().mockResolvedValue(null),
      setDiscussionState: vi.fn(),
    },
  };
});

vi.mock('../../src/ws/wsManager.js', () => ({
  wsManager: { broadcastToRoom: vi.fn() },
}));

vi.mock('../../src/ecies.js', () => ({
  eciesEncrypt: vi.fn().mockReturnValue('encrypted'),
}));

vi.mock('../../src/zk.js', () => ({
  generateEndGameProof: vi.fn().mockResolvedValue({ a: [0, 0], b: [[0, 0], [0, 0]], c: [0, 0], input: [0, 0, 0, 0, 0] }),
  calculatePoseidon: vi.fn().mockImplementation(async (inputs: bigint[]) => {
    // Mock Poseidon: just return a deterministic string
    return `poseidon_${inputs.map(String).join('_')}`;
  }),
}));

const { getRoom, getPlayers } = await import('../../src/chain.js');
const { wsManager } = await import('../../src/ws/wsManager.js');

const CID = 50312;
const ROOM = '42';
const ROOM_KEY = `${CID}:${ROOM}`;

const MAFIA = '0xmafia';
const DOCTOR = '0xdoctor';
const CITIZEN1 = '0xcitizen1';
const CITIZEN2 = '0xcitizen2';

function alivePlayers() {
  return [
    { wallet: MAFIA, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    { wallet: DOCTOR, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    { wallet: CITIZEN1, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    { wallet: CITIZEN2, flags: FLAGS.CONFIRMED_ROLE }, // dead
  ];
}

// ================================================================
// GET /win-check/:roomId
// ================================================================

describe('GET /win-check/:roomId — Win Detection', () => {
  it('returns winDetected=false when game not in active phase', async () => {
    (getRoom as any).mockResolvedValue({ phase: 0 }); // LOBBY
    (getPlayers as any).mockResolvedValue([]);
    const { app } = createTestApp({});

    const res = await request(app)
      .get(`/win-check/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.winDetected).toBe(false);
  });

  it('returns winDetected=false when roles not resolved', async () => {
    (getRoom as any).mockResolvedValue({ phase: 3 }); // DAY
    (getPlayers as any).mockResolvedValue(alivePlayers());
    const { app } = createTestApp({}); // no roles

    const res = await request(app)
      .get(`/win-check/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.winDetected).toBe(false);
  });

  it('detects TOWN_WIN when 0 mafia alive', async () => {
    (getRoom as any).mockResolvedValue({ phase: 3 }); // DAY
    // All alive are non-mafia
    (getPlayers as any).mockResolvedValue([
      { wallet: DOCTOR, flags: FLAGS.ACTIVE },
      { wallet: CITIZEN1, flags: FLAGS.ACTIVE },
      { wallet: MAFIA, flags: FLAGS.CONFIRMED_ROLE }, // dead mafia
    ]);
    const roles = new Map<string, Role>([
      [MAFIA, Role.MAFIA],
      [DOCTOR, Role.DOCTOR],
      [CITIZEN1, Role.CITIZEN],
    ]);
    const { app } = createTestApp({ roles: { roomKey: ROOM_KEY, roles } });

    const res = await request(app)
      .get(`/win-check/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.winDetected).toBe(true);
    expect(res.body.result).toBe('TOWN_WIN');
    expect(wsManager.broadcastToRoom).toHaveBeenCalledWith(ROOM, CID, expect.objectContaining({ type: 'win-detected' }));
  });

  it('detects MAFIA_WIN when mafia >= town', async () => {
    (getRoom as any).mockResolvedValue({ phase: 5 }); // NIGHT
    (getPlayers as any).mockResolvedValue([
      { wallet: MAFIA, flags: FLAGS.ACTIVE },
      { wallet: DOCTOR, flags: FLAGS.ACTIVE },
    ]);
    const roles = new Map<string, Role>([
      [MAFIA, Role.MAFIA],
      [DOCTOR, Role.DOCTOR],
    ]);
    const { app } = createTestApp({ roles: { roomKey: ROOM_KEY, roles } });

    const res = await request(app)
      .get(`/win-check/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.winDetected).toBe(true);
    expect(res.body.result).toBe('MAFIA_WIN');
  });

  it('returns winDetected=false when game is still balanced', async () => {
    (getRoom as any).mockResolvedValue({ phase: 3 });
    (getPlayers as any).mockResolvedValue([
      { wallet: MAFIA, flags: FLAGS.ACTIVE },
      { wallet: DOCTOR, flags: FLAGS.ACTIVE },
      { wallet: CITIZEN1, flags: FLAGS.ACTIVE },
    ]);
    const roles = new Map<string, Role>([
      [MAFIA, Role.MAFIA], [DOCTOR, Role.DOCTOR], [CITIZEN1, Role.CITIZEN],
    ]);
    const { app } = createTestApp({ roles: { roomKey: ROOM_KEY, roles } });

    const res = await request(app)
      .get(`/win-check/${ROOM}`)
      .query({ chainId: String(CID) });

    expect(res.status).toBe(200);
    expect(res.body.winDetected).toBe(false);
  });
});

// ================================================================
// POST /submit-role-secret
// ================================================================

describe('POST /submit-role-secret — Secret Storage', () => {
  it('stores secret with valid commitment', async () => {
    const { app } = createTestApp({ autoAuthSigner: MAFIA });

    // Mock calculatePoseidon returns `poseidon_${mappedRole}_${BigInt("0x" + salt)}`
    // mappedRole for role=1 is 1. salt without 0x prefix = "abcdef1234567890"
    // BigInt("0x" + "abcdef1234567890") = 12379813738877118576n
    const expectedCommitment = `poseidon_1_${BigInt("0xabcdef1234567890")}`;

    const res = await request(app)
      .post('/submit-role-secret')
      .send({
        roomId: ROOM,
        playerAddress: MAFIA,
        role: 1,
        salt: 'abcdef1234567890',
        commitment: expectedCommitment,
        signature: '0xsig',
        signerAddress: MAFIA,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects commitment mismatch', async () => {
    const { app } = createTestApp({ autoAuthSigner: MAFIA });

    const res = await request(app)
      .post('/submit-role-secret')
      .send({
        roomId: ROOM,
        playerAddress: MAFIA,
        role: 1,
        salt: 'abcdef1234567890',
        commitment: 'WRONG_COMMITMENT',
        signature: '0xsig',
        signerAddress: MAFIA,
        nonce: 'n1',
        timestamp: Date.now(),
        chainId: CID,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('mismatch');
  });

  it('rejects missing fields', async () => {
    const { app } = createTestApp({ autoAuthSigner: MAFIA });

    const res = await request(app)
      .post('/submit-role-secret')
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
  });

  it('rejects without auth', async () => {
    const { app } = createTestApp({});

    const res = await request(app)
      .post('/submit-role-secret')
      .send({
        roomId: ROOM, playerAddress: MAFIA, role: 1, salt: 'x', commitment: 'y',
        signature: '0xsig', nonce: 'n1', timestamp: Date.now(), chainId: CID,
      });

    expect(res.status).toBe(401);
  });
});

// ================================================================
// POST /request-join — Password Verification
// ================================================================

describe('POST /request-join — Room Join with Password', () => {
  beforeEach(() => {
    (getRoom as any).mockResolvedValue({ host: '0xhost', tournamentId: 0n });
  });

  it('full flow: set password → verify correct password → get GM signature', async () => {
    const { app } = createTestApp({ autoAuthSigner: '0xhost' });

    // Step 1: Host sets password
    await request(app)
      .post('/room-password')
      .send({
        roomId: ROOM, password: 'secret', hostAddress: '0xhost',
        signature: '0xsig', signerAddress: '0xhost', nonce: 'n1', timestamp: Date.now(), chainId: CID,
      });

    // Step 2: Player requests join with correct password
    const res = await request(app)
      .post('/request-join')
      .send({ roomId: ROOM, password: 'secret', playerAddress: '0xjoiner', chainId: CID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.gmSignature).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const { app } = createTestApp({ autoAuthSigner: '0xhost' });

    await request(app)
      .post('/room-password')
      .send({
        roomId: ROOM, password: 'secret', hostAddress: '0xhost',
        signature: '0xsig', signerAddress: '0xhost', nonce: 'n1', timestamp: Date.now(), chainId: CID,
      });

    const res = await request(app)
      .post('/request-join')
      .send({ roomId: ROOM, password: 'WRONG', playerAddress: '0xjoiner', chainId: CID });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Wrong password');
  });

  it('returns 404 when no password set', async () => {
    const { app } = createTestApp({});

    const res = await request(app)
      .post('/request-join')
      .send({ roomId: '999', password: 'anything', playerAddress: '0xjoiner', chainId: CID });

    expect(res.status).toBe(404);
  });

  it('rejects missing fields', async () => {
    const { app } = createTestApp({});

    const res = await request(app)
      .post('/request-join')
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
  });
});

// ================================================================
// GET /room/:roomId — Room Info
// ================================================================

describe('GET /room/:roomId — Room Info Proxy', () => {
  it('returns room + player data', async () => {
    (getRoom as any).mockResolvedValue({
      id: 42n, host: '0xhost', name: 'TestRoom', phase: 3,
      maxPlayers: 10, playersCount: 4, dayCount: 2,
      isPrivate: false, tournamentId: 0n,
    });
    (getPlayers as any).mockResolvedValue([
      { wallet: '0xhost', nickname: 'Host', flags: FLAGS.ACTIVE },
      { wallet: '0xp1', nickname: 'P1', flags: FLAGS.ACTIVE },
    ]);
    const { app } = createTestApp({});

    const res = await request(app).get(`/room/${ROOM}`);

    expect(res.status).toBe(200);
    expect(res.body.room.name).toBe('TestRoom');
    expect(res.body.room.phase).toBe(3);
    expect(res.body.players).toHaveLength(2);
    expect(res.body.players[0].active).toBe(true);
  });
});

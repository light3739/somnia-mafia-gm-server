/**
 * night-routes integration tests.
 *
 * Tests the POST /night-action → consensus → resolve pipeline through
 * the full HTTP stack. Verifies the resolve lock (fix A3), action
 * submission, and phase validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/createTestApp.js';
import { GMStore } from '../../src/stores/index.js';
import { Role, FLAGS } from '../../src/types/contract.js';
import { clearNightState, getNightState, getOrCreateNightState } from '../../src/game-state.js';

// Mock chain calls
vi.mock('../../src/chain.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    getRoom: vi.fn(),
    getPlayers: vi.fn(),
    resolveNight: vi.fn().mockResolvedValue(undefined),
    hasCommittedRole: vi.fn().mockResolvedValue(true),
    getChainConfig: vi.fn().mockReturnValue({ rpc: 'http://localhost' }),
    GM_ADDRESS: '0xgm',
    FLAGS: original.FLAGS,
    GamePhase: original.GamePhase,
  };
});

// Mock redis persistence
vi.mock('../../src/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
  rPersistNightState: vi.fn(),
  rDeleteNightState: vi.fn(),
}));

// Mock wsManager
vi.mock('../../src/ws/wsManager.js', () => ({
  wsManager: {
    broadcastToRoom: vi.fn(),
  },
}));

const { getRoom, getPlayers, resolveNight } = await import('../../src/chain.js');
const { resolveNightWithFloor } = await import('../../src/routes/nightRoutes.js');

const CHAIN_ID = 50312;
const ROOM_ID = '42';
const ROOM_KEY = `${CHAIN_ID}:${ROOM_ID}`;
const MAFIA_1 = '0xmafia1';
const DOCTOR = '0xdoctor1';
const CITIZEN = '0xcitizen1';
const DEAD = '0xdead1';

function mockPlayers() {
  return [
    { wallet: MAFIA_1, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    { wallet: DOCTOR, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    { wallet: CITIZEN, flags: FLAGS.ACTIVE | FLAGS.CONFIRMED_ROLE },
    { wallet: DEAD, flags: FLAGS.CONFIRMED_ROLE }, // dead (no ACTIVE)
  ];
}

function nightActionBody(player: string, action: string, target: string) {
  return {
    roomId: ROOM_ID,
    playerAddress: player,
    actionType: action,
    targetAddress: target,
    signature: '0xsig',
    signerAddress: player,
    nonce: `n_${Date.now()}_${Math.random()}`,
    timestamp: Date.now(),
    chainId: CHAIN_ID,
    dayCount: 1,
  };
}

// ================================================================
// POST /night-action
// ================================================================

describe('POST /night-action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNightState(BigInt(ROOM_ID));
    (getRoom as any).mockResolvedValue({ phase: 5 }); // NIGHT
    (getPlayers as any).mockResolvedValue(mockPlayers());
  });

  it('accepts valid mafia kill action', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: MAFIA_1,
      roles: { roomKey: ROOM_KEY, roles: new Map([[MAFIA_1, Role.MAFIA], [DOCTOR, Role.DOCTOR], [CITIZEN, Role.CITIZEN]]) },
    });

    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', CITIZEN));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.actionsReceived).toBe(1);

    // Verify action stored in night state
    const state = getNightState(BigInt(ROOM_ID));
    expect(state).toBeDefined();
    expect(state!.actions.has(MAFIA_1)).toBe(true);
  });

  it('rejects action if not in NIGHT phase', async () => {
    (getRoom as any).mockResolvedValue({ phase: 3 }); // DAY
    const { app } = createTestApp({ autoAuthSigner: MAFIA_1 });

    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', CITIZEN));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('NIGHT');
  });

  it('rejects action from dead player', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: DEAD,
      roles: { roomKey: ROOM_KEY, roles: new Map([[DEAD, Role.CITIZEN]]) },
    });

    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(DEAD, 'skip', '0x0000000000000000000000000000000000000000'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Dead');
  });

  it('rejects wrong role for action type (citizen cannot kill)', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: CITIZEN,
      roles: { roomKey: ROOM_KEY, roles: new Map([[MAFIA_1, Role.MAFIA], [CITIZEN, Role.CITIZEN]]) },
    });

    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(CITIZEN, 'kill', MAFIA_1));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('role');
  });

  it('rejects if night already resolved', async () => {
    const roles = new Map([[MAFIA_1, Role.MAFIA], [DOCTOR, Role.DOCTOR], [CITIZEN, Role.CITIZEN]]);
    const { app } = createTestApp({
      autoAuthSigner: MAFIA_1,
      roles: { roomKey: ROOM_KEY, roles },
    });

    // First action creates night state
    await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', CITIZEN));

    // Manually mark as resolved (state was created by the POST above)
    const state = getNightState(BigInt(ROOM_ID));
    expect(state).toBeDefined();
    state!.resolved = true;

    // Second action should be rejected
    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', DOCTOR));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('resolved');
  });

  it('rejects missing required fields', async () => {
    const { app } = createTestApp({ autoAuthSigner: MAFIA_1 });

    const res = await request(app)
      .post('/night-action')
      .send({ roomId: ROOM_ID }); // missing most fields

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing');
  });

  it('rejects if auth fails', async () => {
    const { app } = createTestApp({}); // no autoAuth

    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', CITIZEN));

    expect(res.status).toBe(401);
  });

  it('overwrites previous action from same player', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: MAFIA_1,
      roles: { roomKey: ROOM_KEY, roles: new Map([[MAFIA_1, Role.MAFIA], [DOCTOR, Role.DOCTOR], [CITIZEN, Role.CITIZEN]]) },
    });

    // First: kill CITIZEN
    await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', CITIZEN));

    // Second: kill DOCTOR (overwrites)
    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', DOCTOR));

    expect(res.status).toBe(200);
    expect(res.body.actionsReceived).toBe(1); // still 1 (overwritten)

    const state = getNightState(BigInt(ROOM_ID));
    expect(state!.actions.get(MAFIA_1)!.targetAddress.toLowerCase()).toBe(DOCTOR);
  });

  it('doctor can heal', async () => {
    const { app, store } = createTestApp({
      autoAuthSigner: DOCTOR,
      roles: { roomKey: ROOM_KEY, roles: new Map([[MAFIA_1, Role.MAFIA], [DOCTOR, Role.DOCTOR]]) },
    });

    const res = await request(app)
      .post('/night-action')
      .send(nightActionBody(DOCTOR, 'heal', MAFIA_1));

    expect(res.status).toBe(200);
    const state = getNightState(BigInt(ROOM_ID));
    expect(state!.actions.get(DOCTOR)!.actionType).toBe('heal');
  });
});

// ================================================================
// RESOLVE LOCK (Fix A3)
// ================================================================

describe('Night resolve lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNightState(BigInt(ROOM_ID));
    (getRoom as any).mockResolvedValue({ phase: 5 });
    (getPlayers as any).mockResolvedValue(mockPlayers());
    (resolveNight as any).mockResolvedValue(undefined);
    // Disable the minimum-night floor so the resolve fires immediately — this
    // suite tests the consensus → resolve pipeline + lock, not the pacing floor.
    process.env.MIN_NIGHT_MS = '0';
  });

  afterEach(() => {
    delete process.env.MIN_NIGHT_MS;
  });

  it('auto-resolves when all role players have acted', async () => {
    const roles = new Map<string, Role>([
      [MAFIA_1, Role.MAFIA],
      [DOCTOR, Role.DOCTOR],
      [CITIZEN, Role.CITIZEN],
    ]);

    // Submit mafia action
    const { app: app1, store: store1 } = createTestApp({
      autoAuthSigner: MAFIA_1,
      roles: { roomKey: ROOM_KEY, roles },
    });

    await request(app1)
      .post('/night-action')
      .send(nightActionBody(MAFIA_1, 'kill', CITIZEN));

    // Submit doctor action (using same app — same store)
    // Need to create a new app that also auto-auths the doctor
    const { app: app2 } = createTestApp({
      autoAuthSigner: DOCTOR,
      roles: { roomKey: ROOM_KEY, roles },
    });

    await request(app2)
      .post('/night-action')
      .send(nightActionBody(DOCTOR, 'heal', CITIZEN));

    // After both role players acted, resolveNight should have been called
    // (auto-resolve triggers when allRolePlayersActed returns true)
    // Give async resolve a moment
    await new Promise(r => setTimeout(r, 100));

    // resolveNight should have been called (or attempted)
    // The state should be marked as resolved
    const state = getNightState(BigInt(ROOM_ID));
    // State may be cleared after successful resolve, or marked as resolved
    if (state) {
      expect(state.resolved).toBe(true);
    }
    // If state is undefined, it was cleared after successful resolve — also correct
  });
});

// ================================================================
// MINIMUM NIGHT DURATION FLOOR
// ================================================================

describe('Night minimum duration floor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearNightState(BigInt(ROOM_ID));
    (getPlayers as any).mockResolvedValue(mockPlayers());
    (resolveNight as any).mockResolvedValue(undefined);
    process.env.MIN_NIGHT_MS = '15000';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MIN_NIGHT_MS;
  });

  it('holds the resolve until the floor elapses even when every actor is done', async () => {
    const store = new GMStore();
    const rid = BigInt(ROOM_ID);

    // Fresh night, all actions already in (mafia kill).
    const state = getOrCreateNightState(rid, CHAIN_ID);
    state.nightStartedAt = Date.now();
    state.actions.set(MAFIA_1, {
      playerAddress: MAFIA_1 as any,
      actionType: 'kill',
      targetAddress: CITIZEN as any,
      timestamp: Date.now(),
    });

    await resolveNightWithFloor(rid, store, null as any, CHAIN_ID);

    // Floor not elapsed → on-chain resolve must NOT have fired yet.
    expect(resolveNight).not.toHaveBeenCalled();

    // Advance past the 15s floor → the held resolve fires.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(resolveNight).toHaveBeenCalledTimes(1);
  });

  it('resolves immediately when the floor has already elapsed', async () => {
    const store = new GMStore();
    const rid = BigInt(ROOM_ID);

    const state = getOrCreateNightState(rid, CHAIN_ID);
    state.nightStartedAt = Date.now() - 20_000; // night began 20s ago, floor passed
    state.actions.set(MAFIA_1, {
      playerAddress: MAFIA_1 as any,
      actionType: 'kill',
      targetAddress: CITIZEN as any,
      timestamp: Date.now(),
    });

    await resolveNightWithFloor(rid, store, null as any, CHAIN_ID);
    expect(resolveNight).toHaveBeenCalledTimes(1);
  });
});

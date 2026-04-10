/**
 * game-state.test.ts — Unit tests for night phase consensus logic.
 *
 * Tests the pure functions that determine who dies, who gets healed,
 * and how the night state machine behaves. Zero external dependencies.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateMafiaConsensus,
  getDoctorHeal,
  getOrCreateNightState,
  getNightState,
  clearNightState,
  injectNightState,
  type NightAction,
  type RoomNightState,
} from '../src/game-state.js';

// ---- Helpers ----

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ALICE = '0x000000000000000000000000000000000000aLiC' as const;
const BOB   = '0x000000000000000000000000000000000000b0b0' as const;
const CAROL = '0x000000000000000000000000000000000000caRo' as const;

function killAction(player: string, target: string): NightAction {
  return { playerAddress: player as any, actionType: 'kill', targetAddress: target as any, timestamp: Date.now() };
}
function healAction(player: string, target: string): NightAction {
  return { playerAddress: player as any, actionType: 'heal', targetAddress: target as any, timestamp: Date.now() };
}
function checkAction(player: string, target: string): NightAction {
  return { playerAddress: player as any, actionType: 'check', targetAddress: target as any, timestamp: Date.now() };
}
function skipAction(player: string): NightAction {
  return { playerAddress: player as any, actionType: 'skip', targetAddress: ZERO as any, timestamp: Date.now() };
}

// ================================================================
// CONSENSUS LOGIC
// ================================================================

describe('calculateMafiaConsensus', () => {
  it('returns zero address when no kill actions', () => {
    expect(calculateMafiaConsensus([])).toBe(ZERO);
    expect(calculateMafiaConsensus([healAction(ALICE, BOB)])).toBe(ZERO);
    expect(calculateMafiaConsensus([skipAction(ALICE)])).toBe(ZERO);
  });

  it('single mafia vote = unanimous consensus', () => {
    const result = calculateMafiaConsensus([killAction(ALICE, BOB)]);
    expect(result.toLowerCase()).toBe(BOB.toLowerCase());
  });

  it('2/2 mafia agree = consensus', () => {
    const actions = [killAction(ALICE, BOB), killAction(CAROL, BOB)];
    expect(calculateMafiaConsensus(actions).toLowerCase()).toBe(BOB.toLowerCase());
  });

  it('2/2 mafia disagree = tie = no kill', () => {
    const actions = [killAction(ALICE, BOB), killAction(CAROL, ALICE)];
    expect(calculateMafiaConsensus(actions)).toBe(ZERO);
  });

  it('2/3 mafia agree = majority = consensus (totalAliveMafia=3)', () => {
    // 2 out of 3 alive mafia voted for BOB. Threshold = floor(3/2)+1 = 2. Passes.
    const actions = [killAction(ALICE, BOB), killAction(CAROL, BOB)];
    expect(calculateMafiaConsensus(actions, 3).toLowerCase()).toBe(BOB.toLowerCase());
  });

  it('1/3 mafia vote = no majority (totalAliveMafia=3)', () => {
    // Only 1 vote, threshold = 2. Fails.
    const actions = [killAction(ALICE, BOB)];
    expect(calculateMafiaConsensus(actions, 3)).toBe(ZERO);
  });

  it('AFK mafia counted in threshold (totalAliveMafia > voters)', () => {
    // 1 voter, but totalAliveMafia=2. Threshold = floor(2/2)+1 = 2. 1 < 2 → no kill.
    const actions = [killAction(ALICE, BOB)];
    expect(calculateMafiaConsensus(actions, 2)).toBe(ZERO);
  });

  it('falls back to voter count when totalAliveMafia is 0 or undefined', () => {
    const actions = [killAction(ALICE, BOB)];
    // totalAliveMafia=0 → fallback to killActions.length=1. threshold=1. 1>=1 → kill.
    expect(calculateMafiaConsensus(actions, 0).toLowerCase()).toBe(BOB.toLowerCase());
    expect(calculateMafiaConsensus(actions, undefined).toLowerCase()).toBe(BOB.toLowerCase());
  });

  it('non-kill actions are ignored in vote count', () => {
    const actions = [
      killAction(ALICE, BOB),
      healAction(CAROL, BOB),
      checkAction('0x0000000000000000000000000000000000000004', ALICE),
    ];
    // Only 1 kill → 1 voter. Threshold = 1. Passes.
    expect(calculateMafiaConsensus(actions).toLowerCase()).toBe(BOB.toLowerCase());
  });

  it('case-insensitive target matching', () => {
    const actions = [
      killAction(ALICE, '0xABCDEF0000000000000000000000000000000001'),
      killAction(CAROL, '0xabcdef0000000000000000000000000000000001'),
    ];
    // Should count as same target (lowercase comparison)
    const result = calculateMafiaConsensus(actions);
    expect(result.toLowerCase()).toBe('0xabcdef0000000000000000000000000000000001');
  });

  it('3-way tie = no kill', () => {
    const m1 = '0x0000000000000000000000000000000000000001' as const;
    const m2 = '0x0000000000000000000000000000000000000002' as const;
    const m3 = '0x0000000000000000000000000000000000000003' as const;
    const actions = [killAction(m1, ALICE), killAction(m2, BOB), killAction(m3, CAROL)];
    expect(calculateMafiaConsensus(actions)).toBe(ZERO);
  });
});

// ================================================================
// DOCTOR HEAL
// ================================================================

describe('getDoctorHeal', () => {
  it('returns zero address when no heal action', () => {
    expect(getDoctorHeal([])).toBe(ZERO);
    expect(getDoctorHeal([killAction(ALICE, BOB)])).toBe(ZERO);
  });

  it('returns heal target', () => {
    const actions = [killAction(ALICE, BOB), healAction(CAROL, BOB)];
    expect(getDoctorHeal(actions).toLowerCase()).toBe(BOB.toLowerCase());
  });

  it('uses first heal action if multiple exist', () => {
    const actions = [
      healAction(ALICE, BOB),
      healAction(CAROL, ALICE),
    ];
    // .find() returns first match
    expect(getDoctorHeal(actions).toLowerCase()).toBe(BOB.toLowerCase());
  });
});

// ================================================================
// NIGHT STATE MANAGEMENT
// ================================================================

describe('Night State Management', () => {
  const ROOM_ID = 42n;

  beforeEach(() => {
    clearNightState(ROOM_ID);
  });

  it('getOrCreateNightState creates new state', () => {
    const state = getOrCreateNightState(ROOM_ID, 50312);
    expect(state.roomId).toBe(ROOM_ID);
    expect(state.chainId).toBe(50312);
    expect(state.resolved).toBe(false);
    expect(state.actions.size).toBe(0);
  });

  it('getOrCreateNightState returns existing state', () => {
    const first = getOrCreateNightState(ROOM_ID, 50312);
    first.actions.set('alice', killAction(ALICE, BOB));

    const second = getOrCreateNightState(ROOM_ID, 50312);
    expect(second.actions.size).toBe(1);
    expect(second).toBe(first); // same reference
  });

  it('clearNightState removes state', () => {
    getOrCreateNightState(ROOM_ID, 50312);
    clearNightState(ROOM_ID);
    expect(getNightState(ROOM_ID)).toBeUndefined();
  });

  it('getNightState returns undefined for unknown room', () => {
    expect(getNightState(999n)).toBeUndefined();
  });

  it('injectNightState restores from Redis', () => {
    const restored: RoomNightState = {
      roomId: ROOM_ID,
      chainId: 50312,
      actions: new Map([['alice', killAction(ALICE, BOB)]]),
      resolved: false,
      nightStartedAt: Date.now() - 30_000,
    };
    injectNightState(ROOM_ID, restored);

    const state = getNightState(ROOM_ID);
    expect(state).toBeDefined();
    expect(state!.actions.size).toBe(1);
    expect(state!.chainId).toBe(50312);
  });

  it('states are isolated per room', () => {
    const s1 = getOrCreateNightState(1n, 50312);
    const s2 = getOrCreateNightState(2n, 50312);
    s1.actions.set('alice', killAction(ALICE, BOB));

    expect(s2.actions.size).toBe(0);
    expect(s1.actions.size).toBe(1);
  });
});

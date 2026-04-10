/**
 * night-edge-cases.test.ts — Night resolution consensus edge cases.
 *
 * Tests the game logic when players AFK, doctor heals the kill target,
 * detective checks, and various action combinations. Pure unit tests
 * on calculateMafiaConsensus + getDoctorHeal.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateMafiaConsensus,
  getDoctorHeal,
  type NightAction,
} from '../src/game-state.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const VICTIM = '0x000000000000000000000000000000000000dead' as const;
const SAFE = '0x000000000000000000000000000000000000safe' as const;
const M1 = '0x00000000000000000000000000000000000000m1' as const;
const M2 = '0x00000000000000000000000000000000000000m2' as const;
const M3 = '0x00000000000000000000000000000000000000m3' as const;
const DOC = '0x000000000000000000000000000000000000d0c0' as const;

function kill(player: string, target: string): NightAction {
  return { playerAddress: player as any, actionType: 'kill', targetAddress: target as any, timestamp: Date.now() };
}
function heal(player: string, target: string): NightAction {
  return { playerAddress: player as any, actionType: 'heal', targetAddress: target as any, timestamp: Date.now() };
}
function skip(player: string): NightAction {
  return { playerAddress: player as any, actionType: 'skip', targetAddress: ZERO as any, timestamp: Date.now() };
}
function check(player: string, target: string): NightAction {
  return { playerAddress: player as any, actionType: 'check', targetAddress: target as any, timestamp: Date.now() };
}

// ================================================================
// MAFIA AFK SCENARIOS
// ================================================================

describe('Mafia AFK Scenarios', () => {
  it('all mafia AFK (0 kill actions) → peaceful night', () => {
    const actions: NightAction[] = [
      heal(DOC, VICTIM),       // doctor heals
      check('0xdet', VICTIM),  // detective checks
    ];
    expect(calculateMafiaConsensus(actions)).toBe(ZERO);
  });

  it('all mafia skip → peaceful night', () => {
    const actions = [skip(M1), skip(M2)];
    expect(calculateMafiaConsensus(actions)).toBe(ZERO);
  });

  it('1 of 3 mafia acts, 2 AFK → no majority (totalAliveMafia=3)', () => {
    const actions = [kill(M1, VICTIM)];
    // 1 vote, threshold = floor(3/2)+1 = 2. No majority.
    expect(calculateMafiaConsensus(actions, 3)).toBe(ZERO);
  });

  it('2 of 3 mafia act on same target, 1 AFK → majority = kill', () => {
    const actions = [kill(M1, VICTIM), kill(M2, VICTIM)];
    // 2 votes, threshold = 2. Passes.
    expect(calculateMafiaConsensus(actions, 3).toLowerCase()).toBe(VICTIM.toLowerCase());
  });

  it('2 of 3 mafia act on DIFFERENT targets, 1 AFK → tie = no kill', () => {
    const actions = [kill(M1, VICTIM), kill(M2, SAFE)];
    // 1 vs 1, both below threshold=2. Tie.
    expect(calculateMafiaConsensus(actions, 3)).toBe(ZERO);
  });
});

// ================================================================
// DOCTOR HEAL INTERACTIONS
// ================================================================

describe('Doctor Heal Interactions', () => {
  it('doctor heals the kill target → saved (kill + heal cancel)', () => {
    const actions = [kill(M1, VICTIM), heal(DOC, VICTIM)];

    const killTarget = calculateMafiaConsensus(actions);
    const healTarget = getDoctorHeal(actions);

    // Production logic: if kill == heal, cancel the kill
    expect(killTarget.toLowerCase()).toBe(VICTIM.toLowerCase());
    expect(healTarget.toLowerCase()).toBe(VICTIM.toLowerCase());

    // Simulating GM server doResolveNight logic:
    const effectiveKill = killTarget.toLowerCase() === healTarget.toLowerCase() ? ZERO : killTarget;
    expect(effectiveKill).toBe(ZERO); // saved!
  });

  it('doctor heals wrong target → kill proceeds', () => {
    const actions = [kill(M1, VICTIM), heal(DOC, SAFE)];

    const killTarget = calculateMafiaConsensus(actions);
    const healTarget = getDoctorHeal(actions);

    expect(killTarget.toLowerCase()).toBe(VICTIM.toLowerCase());
    expect(healTarget.toLowerCase()).toBe(SAFE.toLowerCase());

    const effectiveKill = killTarget.toLowerCase() === healTarget.toLowerCase() ? ZERO : killTarget;
    expect(effectiveKill.toLowerCase()).toBe(VICTIM.toLowerCase()); // not saved
  });

  it('doctor heals when no mafia kill → no effect', () => {
    const actions = [heal(DOC, SAFE)];

    const killTarget = calculateMafiaConsensus(actions);
    const healTarget = getDoctorHeal(actions);

    expect(killTarget).toBe(ZERO);
    expect(healTarget.toLowerCase()).toBe(SAFE.toLowerCase());

    // No kill to cancel
    const effectiveKill = killTarget.toLowerCase() === healTarget.toLowerCase() ? ZERO : killTarget;
    expect(effectiveKill).toBe(ZERO);
  });

  it('doctor AFK + mafia kills → kill succeeds', () => {
    const actions = [kill(M1, VICTIM)];

    const killTarget = calculateMafiaConsensus(actions);
    const healTarget = getDoctorHeal(actions);

    expect(killTarget.toLowerCase()).toBe(VICTIM.toLowerCase());
    expect(healTarget).toBe(ZERO); // no heal

    const effectiveKill = killTarget.toLowerCase() === healTarget.toLowerCase() ? ZERO : killTarget;
    expect(effectiveKill.toLowerCase()).toBe(VICTIM.toLowerCase());
  });
});

// ================================================================
// DETECTIVE CHECK (no gameplay effect, just data)
// ================================================================

describe('Detective Check', () => {
  it('check action does not affect kill consensus', () => {
    const actions = [
      kill(M1, VICTIM),
      check('0xdet', M1), // detective checks mafia
    ];

    // Only kill actions count for consensus
    const killTarget = calculateMafiaConsensus(actions);
    expect(killTarget.toLowerCase()).toBe(VICTIM.toLowerCase());
  });

  it('check action does not count as heal', () => {
    const actions = [check('0xdet', VICTIM)];
    expect(getDoctorHeal(actions)).toBe(ZERO);
  });
});

// ================================================================
// FULL NIGHT SCENARIO SIMULATIONS
// ================================================================

describe('Full Night Scenarios', () => {
  it('Classic night: 2 mafia vote same target, doctor heals wrong player', () => {
    const actions = [
      kill(M1, VICTIM),
      kill(M2, VICTIM),
      heal(DOC, SAFE),
      check('0xdet', M1),
    ];

    const killTarget = calculateMafiaConsensus(actions, 2);
    const healTarget = getDoctorHeal(actions);

    expect(killTarget.toLowerCase()).toBe(VICTIM.toLowerCase());
    expect(healTarget.toLowerCase()).toBe(SAFE.toLowerCase());

    const effectiveKill = killTarget.toLowerCase() === healTarget.toLowerCase() ? ZERO : killTarget;
    expect(effectiveKill.toLowerCase()).toBe(VICTIM.toLowerCase()); // VICTIM dies
  });

  it('Classic night: mafia kills, doctor saves', () => {
    const actions = [
      kill(M1, VICTIM),
      kill(M2, VICTIM),
      heal(DOC, VICTIM),
    ];

    const killTarget = calculateMafiaConsensus(actions, 2);
    const healTarget = getDoctorHeal(actions);
    const effectiveKill = killTarget.toLowerCase() === healTarget.toLowerCase() ? ZERO : killTarget;

    expect(effectiveKill).toBe(ZERO); // saved!
  });

  it('Chaotic night: 3 mafia disagree → peaceful', () => {
    const t1 = '0x0000000000000000000000000000000000000001' as const;
    const t2 = '0x0000000000000000000000000000000000000002' as const;
    const t3 = '0x0000000000000000000000000000000000000003' as const;
    const actions = [
      kill(M1, t1),
      kill(M2, t2),
      kill(M3, t3),
      heal(DOC, t1),
    ];

    expect(calculateMafiaConsensus(actions, 3)).toBe(ZERO); // 3-way tie
  });

  it('Solo mafia (1 alive) → always kills', () => {
    const actions = [kill(M1, VICTIM)];
    // totalAliveMafia=1. threshold=1. 1 vote >= 1. Kills.
    expect(calculateMafiaConsensus(actions, 1).toLowerCase()).toBe(VICTIM.toLowerCase());
  });

  it('Empty night (no actions at all) → peaceful', () => {
    expect(calculateMafiaConsensus([])).toBe(ZERO);
    expect(getDoctorHeal([])).toBe(ZERO);
  });
});

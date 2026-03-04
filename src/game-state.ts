import type { Address } from 'viem';

// ─── Types ────────────────────────────────────────────────

export interface NightAction {
  playerAddress: Address;
  actionType: 'kill' | 'heal' | 'check';
  targetAddress: Address;
  timestamp: number;
}

export interface RoomNightState {
  roomId: bigint;
  actions: Map<string, NightAction>; // playerAddress → action (one per player)
  resolved: boolean;
  nightStartedAt: number;
}

// ─── State ────────────────────────────────────────────────

/** Active night states per room */
const nightStates = new Map<string, RoomNightState>(); // roomId string → state

export function getOrCreateNightState(roomId: bigint): RoomNightState {
  const key = roomId.toString();
  let state = nightStates.get(key);
  if (!state) {
    state = {
      roomId,
      actions: new Map(),
      resolved: false,
      nightStartedAt: Date.now(),
    };
    nightStates.set(key, state);
  }
  return state;
}

export function clearNightState(roomId: bigint): void {
  nightStates.delete(roomId.toString());
}

export function getNightState(roomId: bigint): RoomNightState | undefined {
  return nightStates.get(roomId.toString());
}

export function getAllNightStates(): Map<string, RoomNightState> {
  return nightStates;
}

// ─── Consensus logic ──────────────────────────────────────

/**
 * Calculate mafia kill target by majority vote.
 * Returns address(0) if no consensus.
 */
export function calculateMafiaConsensus(actions: NightAction[]): Address {
  const killActions = actions.filter((a) => a.actionType === 'kill');
  if (killActions.length === 0) return '0x0000000000000000000000000000000000000000';

  // Count votes per target
  const votes = new Map<string, number>();
  for (const action of killActions) {
    const target = action.targetAddress.toLowerCase();
    votes.set(target, (votes.get(target) || 0) + 1);
  }

  // Find majority (> 50% of mafia members)
  const threshold = Math.ceil(killActions.length / 2);
  let bestTarget = '0x0000000000000000000000000000000000000000';
  let bestCount = 0;

  for (const [target, count] of votes) {
    if (count > bestCount) {
      bestCount = count;
      bestTarget = target;
    }
  }

  // Need at least a plurality (most votes, ties = no kill)
  if (bestCount >= threshold) {
    return bestTarget as Address;
  }

  return '0x0000000000000000000000000000000000000000';
}

/**
 * Get the doctor's heal target.
 * Returns address(0) if no doctor action.
 */
export function getDoctorHeal(actions: NightAction[]): Address {
  const healAction = actions.find((a) => a.actionType === 'heal');
  return healAction?.targetAddress || '0x0000000000000000000000000000000000000000';
}

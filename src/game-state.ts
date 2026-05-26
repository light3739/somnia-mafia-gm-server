import type { Address } from 'viem';

// ─── Types ────────────────────────────────────────────────

export interface NightAction {
  playerAddress: Address;
  actionType: 'kill' | 'heal' | 'check' | 'skip';
  targetAddress: Address;
  timestamp: number;
}

export interface RoomNightState {
  roomId: bigint;
  chainId: number;
  actions: Map<string, NightAction>; // playerAddress → action (one per player)
  resolved: boolean;
  nightStartedAt: number;
}

// ─── State ────────────────────────────────────────────────

/** Active night states per room */
const nightStates = new Map<string, RoomNightState>(); // roomId string → state

export function getOrCreateNightState(roomId: bigint, chainId: number): RoomNightState {
  const key = roomId.toString();
  let state = nightStates.get(key);
  if (!state) {
    state = {
      roomId,
      chainId,
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

/** Inject a pre-loaded night state (used during Redis startup restore). */
export function injectNightState(roomId: bigint, state: RoomNightState): void {
  nightStates.set(roomId.toString(), state);
}

// ─── Consensus logic ──────────────────────────────────────

/**
 * Calculate mafia kill target by majority vote.
 * @param actions - all night actions submitted
 * @param totalAliveMafia - total alive mafia count (including AFK). If 0/undefined, falls back to voters count.
 * Returns address(0) if no consensus or tie.
 */
export function calculateMafiaConsensus(actions: NightAction[], totalAliveMafia?: number): Address {
  const killActions = actions.filter((a) => a.actionType === 'kill');
  if (killActions.length === 0) return '0x0000000000000000000000000000000000000000';

  // Count votes per target
  const votes = new Map<string, number>();
  for (const action of killActions) {
    const target = action.targetAddress.toLowerCase();
    votes.set(target, (votes.get(target) || 0) + 1);
  }

  // Threshold: majority of total alive mafia (counting AFK).
  // Falls back to majority of voters if total not known.
  const mafiaSize = (totalAliveMafia && totalAliveMafia > 0) ? totalAliveMafia : killActions.length;
  const threshold = Math.floor(mafiaSize / 2) + 1; // strict majority

  // Find candidate with most votes
  let bestTarget = '0x0000000000000000000000000000000000000000';
  let bestCount = 0;
  let tie = false;

  for (const [target, count] of votes) {
    if (count > bestCount) {
      bestCount = count;
      bestTarget = target;
      tie = false;
    } else if (count === bestCount) {
      tie = true; // two candidates with equal top votes → no kill
    }
  }

  // Require strict majority AND no tie
  if (!tie && bestCount >= threshold) {
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

/**
 * Minimum-night-duration floor. Given when the night started and a minimum
 * duration (ms), returns how many ms remain before the night may resolve.
 * 0 means "resolve now".
 *
 * Without this a night resolves the instant every role-actor has acted —
 * agents commit in ~5s, so the NIGHT phase flashes past before a spectator
 * can read it. Holding the resolve until the floor elapses gives the night a
 * visible duration regardless of how fast (or few) the actors are.
 */
export function nightFloorRemainingMs(
  nightStartedAt: number | undefined,
  minMs: number,
  now: number = Date.now(),
): number {
  if (!nightStartedAt || minMs <= 0) return 0;
  return Math.max(0, minMs - (now - nightStartedAt));
}

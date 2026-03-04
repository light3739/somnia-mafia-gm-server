// ─── State ────────────────────────────────────────────────
/** Active night states per room */
const nightStates = new Map(); // roomId string → state
export function getOrCreateNightState(roomId) {
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
export function clearNightState(roomId) {
    nightStates.delete(roomId.toString());
}
export function getNightState(roomId) {
    return nightStates.get(roomId.toString());
}
export function getAllNightStates() {
    return nightStates;
}
// ─── Consensus logic ──────────────────────────────────────
/**
 * Calculate mafia kill target by majority vote.
 * Returns address(0) if no consensus.
 */
export function calculateMafiaConsensus(actions) {
    const killActions = actions.filter((a) => a.actionType === 'kill');
    if (killActions.length === 0)
        return '0x0000000000000000000000000000000000000000';
    // Count votes per target
    const votes = new Map();
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
        return bestTarget;
    }
    return '0x0000000000000000000000000000000000000000';
}
/**
 * Get the doctor's heal target.
 * Returns address(0) if no doctor action.
 */
export function getDoctorHeal(actions) {
    const healAction = actions.find((a) => a.actionType === 'heal');
    return healAction?.targetAddress || '0x0000000000000000000000000000000000000000';
}

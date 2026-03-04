import type { Address } from 'viem';
export interface NightAction {
    playerAddress: Address;
    actionType: 'kill' | 'heal' | 'check';
    targetAddress: Address;
    timestamp: number;
}
export interface RoomNightState {
    roomId: bigint;
    actions: Map<string, NightAction>;
    resolved: boolean;
    nightStartedAt: number;
}
export declare function getOrCreateNightState(roomId: bigint): RoomNightState;
export declare function clearNightState(roomId: bigint): void;
export declare function getNightState(roomId: bigint): RoomNightState | undefined;
export declare function getAllNightStates(): Map<string, RoomNightState>;
/**
 * Calculate mafia kill target by majority vote.
 * Returns address(0) if no consensus.
 */
export declare function calculateMafiaConsensus(actions: NightAction[]): Address;
/**
 * Get the doctor's heal target.
 * Returns address(0) if no doctor action.
 */
export declare function getDoctorHeal(actions: NightAction[]): Address;

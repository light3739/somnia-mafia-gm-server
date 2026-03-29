/**
 * 🛠️ Contract Types & Enums
 * AUTO-GENERATED from Diamond ABI
 */
import type { AbiParametersToPrimitiveTypes, ExtractAbiFunction } from 'abitype';
import { DIAMOND_ABI } from '../abi.js';

// ─── Contract Return Types ─────────────────────────────────

// extract 'getRoom' output tuple type
type GetRoomAbi = ExtractAbiFunction<typeof DIAMOND_ABI, 'getRoom'>;
export type Room = AbiParametersToPrimitiveTypes<GetRoomAbi['outputs']>[0];

// extract 'getPlayers' output tuple array type
type GetPlayersAbi = ExtractAbiFunction<typeof DIAMOND_ABI, 'getPlayers'>;
export type Player = AbiParametersToPrimitiveTypes<GetPlayersAbi['outputs']>[0][number];

// extract 'getTournament' output tuple type
type GetTournamentAbi = ExtractAbiFunction<typeof DIAMOND_ABI, 'getTournament'>;
export type Tournament = AbiParametersToPrimitiveTypes<GetTournamentAbi['outputs']>[0];

// extract 'sessionKeys' output type
type SessionKeysAbi = ExtractAbiFunction<typeof DIAMOND_ABI, 'sessionKeys'>;
export type SessionKeyInfo = AbiParametersToPrimitiveTypes<SessionKeysAbi['outputs']>[0];

// ─── Enums & Flags ─────────────────────────────────────────

export enum GamePhase {
  LOBBY = 0,
  SHUFFLING = 1,
  REVEAL = 2,
  DAY = 3,
  VOTING = 4,
  NIGHT = 5,
  ENDED = 6
}

export enum Role {
  NONE = 0,
  MAFIA = 1,
  DOCTOR = 2,
  DETECTIVE = 3,
  CITIZEN = 4
}

export const FLAGS = {
  CONFIRMED_ROLE: 0x1,
  ACTIVE: 0x2,
  HAS_VOTED: 0x4,
  HAS_COMMITTED: 0x8,
  HAS_REVEALED: 0x10,
  HAS_SHARED_KEYS: 0x20,
  DECK_COMMITTED: 0x40,
  CLAIMED_MAFIA: 0x80,
  CLAIMED_DETECTIVE: 0x100,
} as const;

/**
 * crypto/sra.ts — SRA (commutative encryption) helpers.
 * Mirrors the frontend's shuffleService.ts but runs on the server side.
 */

export const SRA_PRIME = BigInt(
  '0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381' +
  'FFFFFFFFFFFFFFFF',
);

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

export function sraDecryptCard(encryptedCard: string, decryptionKeys: string[]): string {
  let val = BigInt(encryptedCard);
  for (const key of decryptionKeys) val = modPow(val, BigInt(key), SRA_PRIME);
  return val.toString();
}

export function getCardOffset(roomId: number | string | bigint): number {
  const rid = BigInt(roomId);
  const result = 100n + ((rid * 7919n + 104729n) % 10000n);
  return Number(result);
}

import { Role } from '../types/contract.js';
import { logger } from '../utils/logger.js';

export function roleFromCardValue(cardValue: string, roomId: number | string | bigint): Role {
  const rid = BigInt(roomId || 0n);
  const offset = BigInt(getCardOffset(rid));
  const n = BigInt(cardValue) - offset;
  const nv = Number(n);
  switch (nv) {
    case 1: return Role.MAFIA;
    case 2: return Role.DOCTOR;
    case 3: return Role.DETECTIVE;
    case 4: return Role.CITIZEN;
    default:
      logger.warn({ cardValue, offset: offset.toString(), decoded: nv, roomId: String(roomId) }, '[roleFromCardValue] Unexpected card value decoded');
      return Role.NONE;
  }
}

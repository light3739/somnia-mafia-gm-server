/**
 * crypto/sra.ts — SRA (commutative encryption) helpers.
 * Mirrors the frontend's shuffleService.ts but runs on the server side.
 */

import { keccak256, encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { randomBytes, randomInt } from "node:crypto";

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

// ─── SRA keygen + encrypt (server-side port of shuffleService.ts) ───
// Decrypt half (modPow / sraDecryptCard / roleFromCardValue) lives above.

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Extended Euclid modular inverse: a^-1 mod m. */
function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("Modular inverse does not exist");
  return ((oldS % m) + m) % m;
}

/** Random value coprime with n (512-bit entropy from node:crypto). */
function generateCoprime(n: bigint): bigint {
  let e: bigint;
  do {
    const arr = randomBytes(64);
    e = 2n;
    for (let i = 0; i < arr.length; i++) e += BigInt(arr[i]) * 256n ** BigInt(i);
    e = (e % (n - 2n)) + 2n;
  } while (gcd(e, n) !== 1n);
  return e;
}

export interface SraKeys {
  /** encryption exponent */
  e: bigint;
  /** decryption exponent (e*d ≡ 1 mod p-1) */
  d: bigint;
}

/** Generate an SRA (commutative) keypair against SRA_PRIME. */
export function generateSraKeys(): SraKeys {
  const e = generateCoprime(SRA_PRIME - 1n);
  const d = modInverse(e, SRA_PRIME - 1n);
  return { e, d };
}

/**
 * Generate keys verified to round-trip encrypt→decrypt for every card value
 * (guards against fixed points). Retries up to maxRetries.
 */
export function generateVerifiedSraKeys(
  cardValues: string[],
  maxRetries = 10
): SraKeys {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const keys = generateSraKeys();
    let ok = true;
    for (const v of cardValues) {
      if (sraDecryptCard(sraEncryptCard(v, keys.e), [keys.d.toString()]) !== v) {
        ok = false;
        break;
      }
    }
    if (ok) return keys;
  }
  return generateSraKeys();
}

/** Encrypt a single card value with encryption exponent e. */
export function sraEncryptCard(value: string, e: bigint): string {
  return modPow(BigInt(value), e, SRA_PRIME).toString();
}

/** Encrypt every card in a deck with the same exponent (in place order). */
export function encryptDeck(deck: string[], e: bigint): string[] {
  return deck.map((card) => sraEncryptCard(card, e));
}

/** Fisher-Yates shuffle using crypto-strong randomness. Does not mutate input. */
export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 32-byte random salt as 64 lowercase hex chars, no 0x prefix. */
export function generateSalt(): string {
  return randomBytes(32).toString("hex");
}

function stripSalt(salt: string): string {
  return salt.startsWith("0x") ? salt.slice(2) : salt;
}

/** keccak256(abi.encode(string[], string)) — matches ShuffleFacet.revealDeck. */
export function deckCommitHash(deck: string[], salt: string): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string[], string"), [
      deck,
      stripSalt(salt),
    ])
  );
}

/** keccak256(abi.encode(uint256, string)) — v1 role commitment (Poseidon deferred). */
export function roleCommitHash(role: number, salt: string): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, string"), [
      BigInt(role),
      stripSalt(salt),
    ])
  );
}

/**
 * Build the initial role deck: roles distributed among active slots, civilians
 * fill inactive slots. mafiaCount mirrors LibGame.expectedMafiaCount on-chain
 * (≤5→1, ≤8→2, ≤11→3, else 4). Card value = role + per-room offset.
 */
export function generateDistributedDeck(
  players: { isAlive: boolean }[],
  roomId: number | string | bigint
): string[] {
  const deck: string[] = new Array(players.length).fill("");
  const offset = getCardOffset(roomId);

  const activeIndices = players
    .map((p, i) => (p.isAlive ? i : -1))
    .filter((i) => i !== -1);
  const activeCount = activeIndices.length;

  const activeRoles: number[] = [];
  const mafiaCount =
    activeCount <= 5 ? 1 : activeCount <= 8 ? 2 : activeCount <= 11 ? 3 : 4;
  for (let i = 0; i < mafiaCount; i++) activeRoles.push(1 + offset); // MAFIA
  if (activeCount >= 4) activeRoles.push(2 + offset); // DOCTOR
  if (activeCount >= 5) activeRoles.push(3 + offset); // DETECTIVE
  while (activeRoles.length < activeCount) activeRoles.push(4 + offset); // CITIZEN

  // Fisher-Yates over active roles (crypto-strong).
  for (let i = activeRoles.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [activeRoles[i], activeRoles[j]] = [activeRoles[j], activeRoles[i]];
  }

  activeIndices.forEach((slot, i) => {
    deck[slot] = activeRoles[i].toString();
  });
  for (let i = 0; i < players.length; i++) {
    if (!players[i].isAlive) deck[i] = (4 + offset).toString();
  }
  return deck;
}

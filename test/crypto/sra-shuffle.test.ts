/**
 * SRA shuffle/keygen port — unit tests (4j phase 1).
 *
 * Verifies the server-side SRA encrypt/keygen half ported from the frontend
 * shuffleService.ts so agents can shuffle headless. Decrypt half already lives
 * in sra.ts (sraDecryptCard / roleFromCardValue).
 */
import { describe, it, expect } from "vitest";
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import {
  generateSraKeys,
  generateVerifiedSraKeys,
  sraEncryptCard,
  encryptDeck,
  shuffleArray,
  deckCommitHash,
  roleCommitHash,
  generateSalt,
  generateDistributedDeck,
  // existing decrypt half
  sraDecryptCard,
  roleFromCardValue,
  getCardOffset,
} from "../../src/crypto/sra.js";
import { Role } from "../../src/types/contract.js";

const ROOM = 8;

function deckFor(aliveCount: number): string[] {
  return generateDistributedDeck(
    Array.from({ length: aliveCount }, () => ({ isAlive: true })),
    ROOM
  );
}

function roleCounts(deck: string[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const card of deck) {
    const r = roleFromCardValue(card, ROOM);
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

describe("SRA keygen + encrypt roundtrip", () => {
  it("single-key encrypt → decrypt is identity for every card value", () => {
    const deck = deckFor(6);
    const { e, d } = generateVerifiedSraKeys(deck);
    for (const card of deck) {
      const enc = sraEncryptCard(card, e);
      const dec = sraDecryptCard(enc, [d.toString()]);
      expect(dec).toBe(card);
    }
  });

  it("is commutative: two players' encryption decrypts in any key order", () => {
    const deck = deckFor(6);
    const k1 = generateVerifiedSraKeys(deck);
    const k2 = generateVerifiedSraKeys(deck);
    for (const card of deck) {
      const enc = sraEncryptCard(sraEncryptCard(card, k1.e), k2.e);
      expect(sraDecryptCard(enc, [k1.d.toString(), k2.d.toString()])).toBe(card);
      expect(sraDecryptCard(enc, [k2.d.toString(), k1.d.toString()])).toBe(card);
    }
  });

  it("generateVerifiedSraKeys roundtrips all provided card values", () => {
    const deck = deckFor(11);
    const { e, d } = generateVerifiedSraKeys(deck);
    for (const card of deck) {
      expect(sraDecryptCard(sraEncryptCard(card, e), [d.toString()])).toBe(card);
    }
  });

  it("encryptDeck encrypts every card (decrypts back to original deck)", () => {
    const deck = deckFor(5);
    const { e, d } = generateVerifiedSraKeys(deck);
    const enc = encryptDeck(deck, e);
    expect(enc).toHaveLength(deck.length);
    const dec = enc.map((c) => sraDecryptCard(c, [d.toString()]));
    expect(dec).toEqual(deck);
  });
});

describe("commit hashes match on-chain abi.encode format", () => {
  it("deckCommitHash == keccak256(abi.encode(string[], string))", () => {
    const deck = ["101", "102", "103"];
    const salt = generateSalt();
    const expected = keccak256(
      encodeAbiParameters(parseAbiParameters("string[], string"), [deck, salt])
    );
    expect(deckCommitHash(deck, salt)).toBe(expected);
  });

  it("roleCommitHash == keccak256(abi.encode(uint256, string))", () => {
    const salt = generateSalt();
    const expected = keccak256(
      encodeAbiParameters(parseAbiParameters("uint256, string"), [3n, salt])
    );
    expect(roleCommitHash(3, salt)).toBe(expected);
  });

  it("strips a leading 0x from salt before hashing (matches frontend)", () => {
    const raw = generateSalt();
    expect(roleCommitHash(1, `0x${raw}`)).toBe(roleCommitHash(1, raw));
  });
});

describe("generateSalt", () => {
  it("returns 64 lowercase hex chars, no 0x", () => {
    const s = generateSalt();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is random across calls", () => {
    expect(generateSalt()).not.toBe(generateSalt());
  });
});

describe("generateDistributedDeck role counts (mafiaCount: ≤5→1, ≤8→2, ≤11→3, else 4)", () => {
  it("6 alive → 2 mafia, 1 doctor, 1 detective, 2 citizen", () => {
    const c = roleCounts(deckFor(6));
    expect(c[Role.MAFIA]).toBe(2);
    expect(c[Role.DOCTOR]).toBe(1);
    expect(c[Role.DETECTIVE]).toBe(1);
    expect(c[Role.CITIZEN]).toBe(2);
  });

  it("5 alive → 1 mafia, 1 doctor, 1 detective, 2 citizen", () => {
    const c = roleCounts(deckFor(5));
    expect(c[Role.MAFIA]).toBe(1);
    expect(c[Role.DOCTOR]).toBe(1);
    expect(c[Role.DETECTIVE]).toBe(1);
    expect(c[Role.CITIZEN]).toBe(2);
  });

  it("4 alive → 1 mafia, 1 doctor, 0 detective, 2 citizen", () => {
    const c = roleCounts(deckFor(4));
    expect(c[Role.MAFIA]).toBe(1);
    expect(c[Role.DOCTOR]).toBe(1);
    expect(c[Role.DETECTIVE] ?? 0).toBe(0);
    expect(c[Role.CITIZEN]).toBe(2);
  });

  it("deck length equals player count", () => {
    expect(deckFor(6)).toHaveLength(6);
    expect(deckFor(4)).toHaveLength(4);
  });

  it("every card decodes to a known role (offset applied)", () => {
    const offset = getCardOffset(ROOM);
    for (const card of deckFor(6)) {
      const n = Number(BigInt(card) - BigInt(offset));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(4);
    }
  });
});

describe("shuffleArray", () => {
  it("returns a permutation without mutating the input", () => {
    const input = ["a", "b", "c", "d", "e"];
    const copy = [...input];
    const out = shuffleArray(input);
    expect(input).toEqual(copy); // not mutated
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort()); // same multiset
  });
});

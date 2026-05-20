/**
 * resolveRolesFromDeck — pure role-resolution unit tests (4j phase 3).
 *
 * The server (all-agent game) holds every agent's SRA decryption key, so it can
 * decrypt the final on-chain revealedDeck slot-by-slot and map each slot to a
 * role WITHOUT the per-player HTTP submit-sra-key dance. This is the pure core
 * extracted from routes/eciesRoutes.ts /submit-sra-key. Uses the real phase-1
 * SRA primitives end-to-end (no mocks): deal → multi-encrypt → resolve.
 */
import { describe, it, expect } from "vitest";
import {
  generateDistributedDeck,
  generateVerifiedSraKeys,
  encryptDeck,
  roleFromCardValue,
} from "../../src/crypto/sra.js";
import { resolveRolesFromDeck } from "../../src/agents/role-resolve.js";
import { Role } from "../../src/types/contract.js";

const ROOM = 8;

const ADDRS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
  "0x4444444444444444444444444444444444444444",
  "0x5555555555555555555555555555555555555555",
  "0x6666666666666666666666666666666666666666",
];

/** Deal a deck and run it through `shufflerCount` sequential SRA re-encryptions. */
function dealAndShuffle(aliveCount: number, shufflerCount: number) {
  const deck = generateDistributedDeck(
    Array.from({ length: aliveCount }, () => ({ isAlive: true })),
    ROOM
  );
  const unique = [...new Set(deck)];
  const keys = Array.from({ length: shufflerCount }, () =>
    generateVerifiedSraKeys(unique)
  );
  let enc = deck;
  for (const k of keys) enc = encryptDeck(enc, k.e);
  return { deck, enc, decryptionKeys: keys.map((k) => k.d.toString()) };
}

describe("resolveRolesFromDeck", () => {
  it("recovers the dealt role at every slot using all decryption keys", () => {
    const { deck, enc, decryptionKeys } = dealAndShuffle(6, 2);
    const roles = resolveRolesFromDeck(enc, ADDRS, decryptionKeys, ROOM);

    expect(roles.size).toBe(6);
    ADDRS.forEach((addr, i) => {
      expect(roles.get(addr)).toBe(roleFromCardValue(deck[i], ROOM));
    });
  });

  it("preserves the dealt role distribution (2 mafia,1 doc,1 det,2 cit @6)", () => {
    const { enc, decryptionKeys } = dealAndShuffle(6, 3);
    const roles = resolveRolesFromDeck(enc, ADDRS, decryptionKeys, ROOM);
    const counts: Record<number, number> = {};
    for (const r of roles.values()) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts[Role.MAFIA]).toBe(2);
    expect(counts[Role.DOCTOR]).toBe(1);
    expect(counts[Role.DETECTIVE]).toBe(1);
    expect(counts[Role.CITIZEN]).toBe(2);
  });

  it("is key-order independent (SRA commutativity)", () => {
    const { enc, decryptionKeys } = dealAndShuffle(6, 2);
    const forward = resolveRolesFromDeck(enc, ADDRS, decryptionKeys, ROOM);
    const reversed = resolveRolesFromDeck(
      enc,
      ADDRS,
      [...decryptionKeys].reverse(),
      ROOM
    );
    ADDRS.forEach((addr) => expect(reversed.get(addr)).toBe(forward.get(addr)));
  });

  it("returns Role.NONE for every slot when a decryption key is missing", () => {
    const { enc, decryptionKeys } = dealAndShuffle(6, 2);
    const roles = resolveRolesFromDeck(enc, ADDRS, [decryptionKeys[0]], ROOM);
    for (const r of roles.values()) expect(r).toBe(Role.NONE);
  });

  it("lowercases address keys", () => {
    const { enc, decryptionKeys } = dealAndShuffle(6, 1);
    const upper = ADDRS.map((a) => a.toUpperCase().replace("0X", "0x"));
    const roles = resolveRolesFromDeck(enc, upper, decryptionKeys, ROOM);
    expect(roles.has(ADDRS[0])).toBe(true); // lowercased key present
    expect([...roles.keys()].every((k) => k === k.toLowerCase())).toBe(true);
  });

  it("ignores addresses beyond the deck length", () => {
    const { enc, decryptionKeys } = dealAndShuffle(6, 1);
    const extra = [...ADDRS, "0x7777777777777777777777777777777777777777"];
    const roles = resolveRolesFromDeck(enc, extra, decryptionKeys, ROOM);
    expect(roles.size).toBe(6); // 7th addr has no slot
  });
});

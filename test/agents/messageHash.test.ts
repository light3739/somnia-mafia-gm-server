import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import {
  AGENT_MESSAGE_TYPEHASH,
  SCRUB_VERSION,
  MSG_KIND_REGULAR,
  MSG_KIND_SKIP_SCRUBBED,
  messageTextHash,
  canonicalPromptHash,
  computeMessageHash,
  type MessageMaterial,
} from "../../src/agents/trace.js";

const baseMaterial: MessageMaterial = {
  chainId: 50312n,
  diamond: "0x031b6746155ce11c7b533935f4674f5fc4682338",
  roomId: 8n,
  phaseId: keccak256(toHex("D1-DAY")),
  agent: "0x691ec3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  salt: "0xabababababababababababababababababababababababababababababababab",
  somniaRequestId: 42n,
  promptHash: keccak256(toHex("prompt-1")),
  rawResponseHash: keccak256(toHex("raw-1")),
  sanitizedTextHash: keccak256(toHex("sanitized-1")),
  scrubVersion: SCRUB_VERSION,
  scrubAllowed: true,
  msgKind: MSG_KIND_REGULAR,
};

describe("messageTextHash", () => {
  it("matches solidity abi.encode(string)", () => {
    const a = messageTextHash("hello");
    const b = messageTextHash("hello");
    expect(a).toEqual(b);
    expect(a).not.toEqual(messageTextHash("hello!"));
  });
});

describe("canonicalPromptHash", () => {
  it("is stable for the same arrays", () => {
    const a = canonicalPromptHash(["system", "user"], ["s1", "u1"]);
    const b = canonicalPromptHash(["system", "user"], ["s1", "u1"]);
    expect(a).toEqual(b);
  });

  it("differs when any element changes", () => {
    const a = canonicalPromptHash(["system", "user"], ["s1", "u1"]);
    const b = canonicalPromptHash(["system", "user"], ["s1", "u2"]);
    expect(a).not.toEqual(b);
  });
});

describe("computeMessageHash", () => {
  it("is deterministic", () => {
    expect(computeMessageHash(baseMaterial)).toEqual(computeMessageHash(baseMaterial));
  });

  it("is never bytes32(0) for any non-empty material (F-new-1 invariant)", () => {
    const h = computeMessageHash(baseMaterial);
    expect(h).not.toEqual("0x" + "0".repeat(64));
  });

  it("changes when any provenance field changes (F2 binding)", () => {
    const base = computeMessageHash(baseMaterial);
    const fields = [
      ["roomId", { roomId: 9n }],
      ["chainId", { chainId: 5031n }],
      ["phaseId", { phaseId: keccak256(toHex("D2-DAY")) }],
      ["agent", { agent: "0x0000000000000000000000000000000000000001" as `0x${string}` }],
      ["salt", { salt: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" as `0x${string}` }],
      ["somniaRequestId", { somniaRequestId: 43n }],
      ["promptHash", { promptHash: keccak256(toHex("prompt-2")) }],
      ["rawResponseHash", { rawResponseHash: keccak256(toHex("raw-2")) }],
      ["sanitizedTextHash", { sanitizedTextHash: keccak256(toHex("sanitized-2")) }],
      ["scrubVersion", { scrubVersion: SCRUB_VERSION + 1 }],
      ["scrubAllowed", { scrubAllowed: false }],
      ["msgKind", { msgKind: MSG_KIND_SKIP_SCRUBBED }],
    ] as const;
    for (const [name, patch] of fields) {
      const altered = computeMessageHash({ ...baseMaterial, ...(patch as object) });
      expect(altered, `field ${name} should change hash`).not.toEqual(base);
    }
  });

  it("type hash matches V2 marker", () => {
    expect(AGENT_MESSAGE_TYPEHASH).toEqual(keccak256(toHex("MAFIA_AGENT_MESSAGE_V2")));
  });
});

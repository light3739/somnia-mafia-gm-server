/**
 * Unit tests for the off-chain trace builder.
 *
 * Pure unit tests (no chain). The critical cross-check that the off-chain
 * digest matches `AgentRegistryFacet.computeTraceCommitment` lives in
 * SomniaSol/test/AgentRegistryFacet.ts ("commit by registered agent stores
 * commitment and emits event") — this file just covers the JS-side
 * invariants (determinism, domain separation surface, salt entropy).
 */
import { describe, it, expect } from "vitest";
import {
  computeTraceCommitment,
  makePhaseId,
  randomSalt,
  AGENT_TRACE_TYPEHASH,
  type TraceMaterial,
} from "../../src/agents/trace.js";
import { keccak256, toHex } from "viem";

const DIAMOND = "0x031b6746155ce11c7b533935f4674f5fc4682338" as const;
const AGENT = "0x3d92975573e29854e2130d1e70fed76f76388dc1" as const;

function material(over: Partial<TraceMaterial> = {}): TraceMaterial {
  return {
    diamond: DIAMOND,
    chainId: 50312n,
    roomId: 7n,
    phaseId: makePhaseId("VOTING", 3),
    agent: AGENT,
    salt: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
    somniaRequestId: 42n,
    promptHash: keccak256(toHex("prompt")),
    responseHash: keccak256(toHex("response")),
    actionHash: keccak256(toHex("action")),
    ...over,
  };
}

describe("AGENT_TRACE_TYPEHASH", () => {
  it("matches the Solidity constant", () => {
    expect(AGENT_TRACE_TYPEHASH).toBe(keccak256(toHex("MAFIA_AGENT_TRACE_V1")));
  });
});

describe("makePhaseId", () => {
  it("is deterministic", () => {
    expect(makePhaseId("VOTING", 3)).toBe(makePhaseId("VOTING", 3));
  });

  it("changes when day changes", () => {
    expect(makePhaseId("VOTING", 3)).not.toBe(makePhaseId("VOTING", 4));
  });

  it("changes when kind changes", () => {
    expect(makePhaseId("VOTING", 3)).not.toBe(makePhaseId("NIGHT", 3));
    expect(makePhaseId("DAY", 3)).not.toBe(makePhaseId("VOTING", 3));
  });

  it("matches the AgentEvent.phaseId string convention", () => {
    // events.ts builds phaseId strings like "D3-VOTING". This module hashes
    // them. Keep the formats in sync.
    expect(makePhaseId("VOTING", 3)).toBe(keccak256(toHex("D3-VOTING")));
    expect(makePhaseId("NIGHT", 5)).toBe(keccak256(toHex("D5-NIGHT")));
  });
});

describe("computeTraceCommitment", () => {
  it("is deterministic for fixed inputs", () => {
    const m = material();
    expect(computeTraceCommitment(m)).toBe(computeTraceCommitment(m));
  });

  it("changes when chainId changes (cross-chain replay protection)", () => {
    const a = computeTraceCommitment(material({ chainId: 50312n }));
    const b = computeTraceCommitment(material({ chainId: 5031n }));
    expect(a).not.toBe(b);
  });

  it("changes when diamond changes (cross-contract replay protection)", () => {
    const a = computeTraceCommitment(material());
    const b = computeTraceCommitment(
      material({
        diamond: "0x0000000000000000000000000000000000000000",
      })
    );
    expect(a).not.toBe(b);
  });

  it("changes when roomId changes (cross-room replay protection)", () => {
    const a = computeTraceCommitment(material({ roomId: 7n }));
    const b = computeTraceCommitment(material({ roomId: 8n }));
    expect(a).not.toBe(b);
  });

  it("changes when phaseId changes", () => {
    const a = computeTraceCommitment(material({ phaseId: makePhaseId("VOTING", 3) }));
    const b = computeTraceCommitment(material({ phaseId: makePhaseId("NIGHT", 3) }));
    expect(a).not.toBe(b);
  });

  it("changes when agent changes", () => {
    const a = computeTraceCommitment(material({ agent: AGENT }));
    const b = computeTraceCommitment(
      material({ agent: "0x0000000000000000000000000000000000000001" })
    );
    expect(a).not.toBe(b);
  });

  it("changes when any trace material field changes", () => {
    const base = computeTraceCommitment(material());
    expect(computeTraceCommitment(material({ salt: keccak256(toHex("alt-salt")) }))).not.toBe(base);
    expect(computeTraceCommitment(material({ somniaRequestId: 99n }))).not.toBe(base);
    expect(computeTraceCommitment(material({ promptHash: keccak256(toHex("alt-prompt")) }))).not.toBe(base);
    expect(computeTraceCommitment(material({ responseHash: keccak256(toHex("alt-response")) }))).not.toBe(base);
    expect(computeTraceCommitment(material({ actionHash: keccak256(toHex("alt-action")) }))).not.toBe(base);
  });
});

describe("randomSalt", () => {
  it("returns a 0x-prefixed 32-byte hex string", () => {
    const s = randomSalt();
    expect(s.startsWith("0x")).toBe(true);
    expect(s.length).toBe(2 + 64);
    expect(/^0x[0-9a-f]{64}$/.test(s)).toBe(true);
  });

  it("does not repeat across calls (probabilistic)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(randomSalt());
    expect(seen.size).toBe(100);
  });
});

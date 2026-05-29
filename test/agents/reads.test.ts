import { describe, it, expect } from "vitest";
import { deriveReads } from "../../src/agents/reads.js";
import type { Address } from "viem";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const A = "0x2222222222222222222222222222222222222222" as Address;
const B = "0x3333333333333333333333333333333333333333" as Address;
const C = "0x4444444444444444444444444444444444444444" as Address;
const nameOf = (a: string) => ({ [A.toLowerCase()]: "A", [B.toLowerCase()]: "B", [C.toLowerCase()]: "C" } as Record<string, string>)[a.toLowerCase()] ?? "me";

describe("deriveReads", () => {
  it("flags who voted against me", () => {
    const lines = deriveReads([{ day: 1, votes: [{ from: A, to: ME }] }], ME, nameOf);
    expect(lines.join("\n")).toContain("A voted against you on Day 1");
  });
  it("flags a flip across rounds", () => {
    const lines = deriveReads([
      { day: 1, votes: [{ from: A, to: B }] },
      { day: 2, votes: [{ from: A, to: C }] },
    ], ME, nameOf);
    expect(lines.join("\n")).toContain("A switched from voting B to voting C");
  });
  it("flags repeated bandwagon partners", () => {
    const lines = deriveReads([
      { day: 1, votes: [{ from: A, to: C }, { from: B, to: C }] },
      { day: 2, votes: [{ from: A, to: B }, { from: B, to: A }] },
      { day: 3, votes: [{ from: A, to: C }, { from: B, to: C }] },
    ], ME, nameOf);
    expect(lines.join("\n")).toContain("A and B keep voting together");
  });
  it("reminds me of my own last vote", () => {
    const lines = deriveReads([{ day: 1, votes: [{ from: ME, to: A }] }], ME, nameOf);
    expect(lines.join("\n")).toContain("You previously voted A");
  });
  it("empty logs → no lines", () => {
    expect(deriveReads([], ME, nameOf)).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { shufflePlayers } from "../../src/services/discussionTurns.js";

describe("shufflePlayers", () => {
  it("is deterministic for a given roomId", () => {
    const players = [{ wallet: "0xa" }, { wallet: "0xb" }, { wallet: "0xc" }, { wallet: "0xd" }];
    const a = shufflePlayers(players, "8").map((p) => p.wallet);
    const b = shufflePlayers(players, "8").map((p) => p.wallet);
    expect(a).toEqual(b);
  });

  it("returns a permutation (same members) and differs across roomIds", () => {
    const players = [{ wallet: "0xa" }, { wallet: "0xb" }, { wallet: "0xc" }, { wallet: "0xd" }];
    const a = shufflePlayers(players, "8").map((p) => p.wallet).sort();
    expect(a).toEqual(["0xa", "0xb", "0xc", "0xd"]);
    const o8 = shufflePlayers(players, "8").map((p) => p.wallet);
    const o9 = shufflePlayers(players, "9").map((p) => p.wallet);
    expect(o8).not.toEqual(o9);
  });
});

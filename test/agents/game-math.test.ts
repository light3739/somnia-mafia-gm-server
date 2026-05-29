import { describe, it, expect } from "vitest";
import {
  roleCensus,
  computeWinMath,
  censusLines,
  townWinLines,
  mafiaWinLines,
} from "../../src/agents/game-math.js";

describe("roleCensus", () => {
  it("6 players → 2 mafia, 1 doctor, 1 detective, 2 citizens", () => {
    expect(roleCensus(6)).toEqual({ total: 6, mafia: 2, doctor: 1, detective: 1, citizens: 2 });
  });
  it("boundary 5 → 1 mafia; 9 → 3 mafia; 12 → 4 mafia", () => {
    expect(roleCensus(5).mafia).toBe(1);
    expect(roleCensus(9).mafia).toBe(3);
    expect(roleCensus(12).mafia).toBe(4);
  });
  it("4 players → doctor but no detective", () => {
    expect(roleCensus(4)).toEqual({ total: 4, mafia: 1, doctor: 1, detective: 0, citizens: 2 });
  });
});

describe("computeWinMath", () => {
  it("2 mafia / 3 town → 1 town death to mafia win", () => {
    expect(computeWinMath({ aliveCount: 5, mafiaAlive: 2 })).toEqual({
      aliveCount: 5, mafiaAlive: 2, townAlive: 3, townDeathsToMafiaWin: 1,
    });
  });
  it("never negative", () => {
    expect(computeWinMath({ aliveCount: 2, mafiaAlive: 2 }).townDeathsToMafiaWin).toBe(0);
  });
});

describe("prompt lines", () => {
  it("censusLines states setup + headcount", () => {
    const lines = censusLines(6, 4);
    expect(lines[0]).toContain("2 Mafia, 1 Doctor, 1 Detective, 2 Citizens");
    expect(lines[1]).toContain("Alive now: 4 of 6");
    expect(lines[1]).toContain("Eliminated so far: 2");
  });
  it("townWinLines gives positive slack message when town has room", () => {
    const lines = townWinLines({ aliveNow: 5, startingMafia: 2 });
    expect(lines.join(" ")).toContain("at most 1 more");
  });
  it("townWinLines warns when at parity edge", () => {
    const lines = townWinLines({ aliveNow: 4, startingMafia: 2 });
    expect(lines.join(" ")).toContain("one good night from parity");
  });
  it("mafiaWinLines states exact counts + teammates", () => {
    const lines = mafiaWinLines({ mafiaAlive: 2, townAlive: 3, teammateNames: ["Alice"] });
    expect(lines[0]).toContain("you + Alice");
    expect(lines[1]).toContain("Town deaths still needed to win: 1");
  });
});

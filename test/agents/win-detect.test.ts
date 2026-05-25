import { describe, it, expect } from "vitest";
import { computeWinner } from "../../src/agents/win-detect.js";
import { Role } from "../../src/types/contract.js";

const FLAG_ACTIVE = 0x2;
const player = (wallet: string, alive: boolean) => ({ wallet, flags: alive ? FLAG_ACTIVE : 0 });

describe("computeWinner", () => {
  it("mafia wins when alive mafia >= alive town", () => {
    const players = [player("0xM", true), player("0xT", true)];
    const roles = new Map([["0xm", Role.MAFIA], ["0xt", Role.CITIZEN]]);
    expect(computeWinner(players as any, roles)).toEqual({ winner: "MAFIA", mafiaCount: 1, townCount: 1 });
  });
  it("town wins when no mafia alive", () => {
    const players = [player("0xT1", true), player("0xT2", true)];
    const roles = new Map([["0xt1", Role.CITIZEN], ["0xt2", Role.DOCTOR]]);
    expect(computeWinner(players as any, roles)).toEqual({ winner: "TOWN", mafiaCount: 0, townCount: 2 });
  });
  it("no winner when mafia < town and mafia > 0", () => {
    const players = [player("0xM", true), player("0xT1", true), player("0xT2", true)];
    const roles = new Map([["0xm", Role.MAFIA], ["0xt1", Role.CITIZEN], ["0xt2", Role.CITIZEN]]);
    expect(computeWinner(players as any, roles).winner).toBeNull();
  });
  it("ignores dead players in the count", () => {
    const players = [player("0xM", true), player("0xT", false)];
    const roles = new Map([["0xm", Role.MAFIA], ["0xt", Role.CITIZEN]]);
    expect(computeWinner(players as any, roles)).toEqual({ winner: "MAFIA", mafiaCount: 1, townCount: 0 });
  });
});

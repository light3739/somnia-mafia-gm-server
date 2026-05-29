import { describe, it, expect } from "vitest";
import { loadPublicGameContext } from "../../src/agents/strategic-context.js";
import type { Address } from "viem";

class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
}
const CHAIN = 50312, ROOM = "7";
const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;

function logsKey() { return `room:logs:${CHAIN}:${ROOM}`; }

describe("loadPublicGameContext census + deaths", () => {
  it("prepends census + town-win lines when startingActive given", async () => {
    const r = new FakeRedis();
    r.store.set(logsKey(), JSON.stringify([{ eventType: "DayStarted", eventData: { dayNumber: 1 } }]));
    const ctx = await loadPublicGameContext(r as any, {
      chainId: CHAIN, roomId: ROOM, currentDay: 2, alive: [A, B, C], self: A, startingActive: 6,
    });
    expect(ctx.lines[0]).toContain("Game setup: 6 players");
    expect(ctx.lines.join("\n")).toContain("Town LOSES the instant");
  });

  it("exposes latestNightDeath and latestVoteOut from logs", async () => {
    const r = new FakeRedis();
    r.store.set(logsKey(), JSON.stringify([
      { eventType: "DayStarted", eventData: { dayNumber: 1 } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: B, targetAddress: C } },
      { eventType: "VOTING_RESULT", eventData: { playerAddress: C } },
      { eventType: "DayStarted", eventData: { dayNumber: 2 } },
      { eventType: "NIGHT_RESULT", eventData: { playerAddress: B } },
      { eventType: "DayStarted", eventData: { dayNumber: 3 } },
    ]));
    const ctx = await loadPublicGameContext(r as any, {
      chainId: CHAIN, roomId: ROOM, currentDay: 3, alive: [A], self: A, startingActive: 6,
    });
    expect(ctx.latestVoteOut?.toLowerCase()).toBe(C.toLowerCase());
    expect(ctx.latestNightDeath?.toLowerCase()).toBe(B.toLowerCase());
    expect(ctx.latestNightHappened).toBe(true);
  });

  it("latestNightHappened true + latestNightDeath null on a safe night", async () => {
    const r = new FakeRedis();
    r.store.set(logsKey(), JSON.stringify([
      { eventType: "DayStarted", eventData: { dayNumber: 1 } },
      { eventType: "NIGHT_RESULT", eventData: { isSafe: true } },
      { eventType: "DayStarted", eventData: { dayNumber: 2 } },
    ]));
    const ctx = await loadPublicGameContext(r as any, {
      chainId: CHAIN, roomId: ROOM, currentDay: 2, alive: [A], self: A,
    });
    expect(ctx.latestNightHappened).toBe(true);
    expect(ctx.latestNightDeath).toBeNull();
  });
});

/**
 * Unit tests for the AgentEvent normaliser. No chain, no Redis.
 */
import { describe, it, expect } from "vitest";
import { normaliseLog } from "../../src/agents/events.js";

const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as const;

describe("agents/events.normaliseLog", () => {
  it("normalises DayStarted with dayNumber from event args", () => {
    const e = normaliseLog(
      {
        eventName: "DayStarted",
        args: { roomId: 7n, dayNumber: 3n },
        blockNumber: 100n,
        transactionHash: TX,
        logIndex: 2,
      },
      { chainId: 50312 }
    );
    expect(e).not.toBeNull();
    expect(e!.type).toBe("DAY_STARTED");
    expect(e!.roomId).toBe("7");
    expect(e!.chainId).toBe(50312);
    expect((e as any).dayNumber).toBe(3);
    expect((e as any).phaseId).toBe("D3-DAY");
    expect(e!.blockNumber).toBe(100);
    expect(e!.txHash).toBe(TX);
    expect(e!.logIndex).toBe(2);
  });

  it("normalises VotingStarted using dayNumber from ctx", () => {
    const e = normaliseLog(
      {
        eventName: "VotingStarted",
        args: { roomId: 12n },
        blockNumber: 200n,
        transactionHash: TX,
        logIndex: 0,
      },
      { chainId: 50312, dayNumber: 5 }
    );
    expect(e).not.toBeNull();
    expect(e!.type).toBe("VOTING_STARTED");
    expect((e as any).dayNumber).toBe(5);
    expect((e as any).phaseId).toBe("D5-VOTING");
  });

  it("normalises NightStarted using dayNumber from ctx", () => {
    const e = normaliseLog(
      {
        eventName: "NightStarted",
        args: { roomId: 12n },
        blockNumber: 300n,
        transactionHash: TX,
        logIndex: 1,
      },
      { chainId: 50312, dayNumber: 2 }
    );
    expect(e!.type).toBe("NIGHT_STARTED");
    expect((e as any).phaseId).toBe("D2-NIGHT");
  });

  it("normalises GameEnded with winCondition", () => {
    const e = normaliseLog(
      {
        eventName: "GameEnded",
        args: { roomId: 12n, winCondition: "TOWN_WIN" },
        blockNumber: 400n,
        transactionHash: TX,
        logIndex: 0,
      },
      { chainId: 50312 }
    );
    expect(e!.type).toBe("GAME_ENDED");
    expect((e as any).winCondition).toBe("TOWN_WIN");
    expect((e as any).phaseId).toBe("ENDED");
  });

  it("returns null for unrelated events", () => {
    const e = normaliseLog(
      {
        eventName: "PlayerJoined",
        args: { roomId: 1n, player: "0xabc", nickname: "X" },
        blockNumber: 10n,
        transactionHash: TX,
        logIndex: 0,
      },
      { chainId: 50312 }
    );
    expect(e).toBeNull();
  });

  it("returns null when txHash is missing", () => {
    const e = normaliseLog(
      {
        eventName: "DayStarted",
        args: { roomId: 1n, dayNumber: 1n },
        blockNumber: 10n,
        transactionHash: null,
        logIndex: 0,
      },
      { chainId: 50312 }
    );
    expect(e).toBeNull();
  });

  it("returns null when roomId is missing", () => {
    const e = normaliseLog(
      {
        eventName: "DayStarted",
        args: { dayNumber: 1n } as any,
        blockNumber: 10n,
        transactionHash: TX,
        logIndex: 0,
      },
      { chainId: 50312 }
    );
    expect(e).toBeNull();
  });

  it("falls back to dayNumber=0 when ctx.dayNumber missing for VOTING", () => {
    const e = normaliseLog(
      {
        eventName: "VotingStarted",
        args: { roomId: 1n },
        blockNumber: 10n,
        transactionHash: TX,
        logIndex: 0,
      },
      { chainId: 50312 }
    );
    expect((e as any).dayNumber).toBe(0);
    expect((e as any).phaseId).toBe("D0-VOTING");
  });
});

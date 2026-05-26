import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { buildVotePrompt, resolveDecision } from "../src/agents/decision-schema.js";
import { buildNightPrompt } from "../src/agents/night.js";
import {
  loadPrivateNightMemoryLines,
  loadPublicGameContext,
} from "../src/agents/strategic-context.js";
import { agentTraceKey } from "../src/agents/redis-keys.js";
import { AgentRole } from "../src/agents/roles.js";

const A = "0x0000000000000000000000000000000000000001" as Address;
const B = "0x0000000000000000000000000000000000000002" as Address;
const C = "0x0000000000000000000000000000000000000003" as Address;
const D = "0x0000000000000000000000000000000000000004" as Address;

function fakeRedis(values: Map<string, string>) {
  return {
    get: async (key: string) => values.get(key) ?? null,
  };
}

describe("strategic prompt context", () => {
  it("summarizes stalled public votes and suggests the last vote leader", async () => {
    const logs = [
      { eventType: "DayStarted", eventData: { dayNumber: 1 } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: A, targetAddress: C } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: B, targetAddress: C } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: D, targetAddress: B } },
      { eventType: "DayStarted", eventData: { dayNumber: 2 } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: A, targetAddress: C } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: B, targetAddress: C } },
      { eventType: "PLAYER_VOTED", eventData: { voterAddress: D, targetAddress: B } },
      { eventType: "NightResolvedByGM", eventData: { isSafe: true } },
      { eventType: "DayStarted", eventData: { dayNumber: 3 } },
    ];
    const redis = fakeRedis(
      new Map([["room:logs:1:99", JSON.stringify(logs)]])
    );

    const ctx = await loadPublicGameContext(redis, {
      chainId: 1,
      roomId: "99",
      currentDay: 3,
      alive: [A, B, C, D],
      self: A,
      nameOf: (addr) => ({ [A]: "A", [B]: "B", [C]: "C", [D]: "D" }[addr] ?? addr),
    });

    expect(ctx.lines.join("\n")).toContain("Elimination threshold today: 3/4");
    expect(ctx.lines.join("\n")).toContain("Stall warning: 2 recent voting rounds");
    expect(ctx.consensusTarget).toBe(C);
  });

  it("lets vote fallback follow the consensus target and exposes context in the prompt", () => {
    const { prompt } = buildVotePrompt({
      self: A,
      alive: [A, B, C],
      publicChat: [{ from: B, text: "We should stop splitting." }],
      publicContext: ["Stall warning: consolidate on one realistic target."],
      dayCount: 4,
    });
    const decision = resolveDecision(null, {
      self: A,
      alive: [A, B, C],
      action: "vote",
      fallbackTarget: C,
    });

    expect(prompt).toContain("Public game context");
    expect(prompt).toContain("Stall warning");
    expect(decision.target).toBe(C);
  });

  it("adds private night action memory and repeat warnings", async () => {
    const agent = A;
    const target = C;
    const values = new Map<string, string>();
    for (let day = 1; day <= 3; day++) {
      values.set(
        agentTraceKey(1, "99", `D${day}-NIGHT`, agent),
        JSON.stringify({ action: "KILL", target })
      );
    }
    const lines = await loadPrivateNightMemoryLines(fakeRedis(values), {
      chainId: 1,
      roomId: "99",
      agent,
      role: AgentRole.MAFIA,
      currentDay: 4,
      nameOf: (addr) => (addr === target ? "Target" : addr),
    });
    const { messages } = buildNightPrompt({
      self: agent,
      role: AgentRole.MAFIA,
      alive: [agent, B, target],
      dayCount: 4,
      language: "English",
      privateMemory: lines,
    });

    expect(lines.join("\n")).toContain("last 3 kill choices");
    expect(messages.join("\n")).toContain("Your private action memory");
    expect(messages.join("\n")).toContain("switch targets");
  });
});

import { describe, it, expect } from "vitest";
import { buildDayPrompt } from "../../src/agents/day.js";
import { AgentRole } from "../../src/agents/roles.js";

describe("buildDayPrompt recentChat formatting", () => {
  it("renders JSON chat entries as 'shortaddr: text' lines and includes them", () => {
    const { messages } = buildDayPrompt({
      self: "0x1111111111111111111111111111111111111111",
      role: AgentRole.NONE,
      persona: "gruff miner",
      alive: ["0x1111111111111111111111111111111111111111"],
      recentChat: [
        JSON.stringify({ by: "0xABCDEF0000000000000000000000000000000000", text: "I trust nobody", day: 1 }),
        "raw legacy line",
      ],
      dayNumber: 1,
      language: "English",
    });
    const user = messages[1];
    expect(user).toContain("0xabcde: I trust nobody");
    expect(user).toContain("raw legacy line");
  });
});

describe("buildDayPrompt concreteness", () => {
  const base = {
    self: "0x1111111111111111111111111111111111111111" as const,
    persona: "gruff miner",
    alive: ["0x1111111111111111111111111111111111111111" as const],
    recentChat: [] as string[],
    dayNumber: 1,
    language: "English",
  };

  it("system prompt demands specificity and bans vague platitudes", () => {
    const { messages } = buildDayPrompt({ ...base, role: AgentRole.NONE });
    const system = messages[0];
    expect(system).toContain("SPECIFIC");
    expect(system.toLowerCase()).toContain("vague platitudes");
    expect(system).toContain("gruff miner");
  });

  it("role=NONE no longer forces generic observations, still forbids claiming a role", () => {
    const { messages } = buildDayPrompt({ ...base, role: AgentRole.NONE });
    const system = messages[0];
    expect(system).not.toContain("generic social observations");
    expect(system.toLowerCase()).toContain("never claim");
  });

  it("known role keeps secrecy (NEVER reveal)", () => {
    const { messages } = buildDayPrompt({ ...base, role: AgentRole.MAFIA });
    expect(messages[0]).toContain("NEVER reveal");
  });

  it("empty chat: first speaker opens concretely and must not invent quotes", () => {
    const { messages } = buildDayPrompt({ ...base, role: AgentRole.NONE, recentChat: [] });
    const user = messages[1];
    expect(user.toLowerCase()).toContain("first to speak");
    expect(user.toLowerCase()).toContain("do not invent"); // no fabricated quotes
    expect(user).not.toContain("No previous messages yet");
  });
});

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

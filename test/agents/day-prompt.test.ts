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

  it("tells the agent which player is itself and forbids self-targeting", () => {
    const A = ("0x" + "a".repeat(40)) as `0x${string}`;
    const B = ("0x" + "b".repeat(40)) as `0x${string}`;
    const names: Record<string, string> = { [A.toLowerCase()]: "Alice", [B.toLowerCase()]: "Bob" };
    const { messages } = buildDayPrompt({
      ...base,
      self: A,
      role: AgentRole.NONE,
      alive: [A, B],
      recentChat: [],
      nameOf: (a: string) => names[a.toLowerCase()] ?? a.slice(0, 7),
    });
    const text = messages.join("\n");
    expect(text).toContain("Alice"); // its own name surfaced
    expect(text.toLowerCase()).toContain("yourself"); // anti self-accusation instruction
  });

  it("renders the agent's OWN past messages as 'You', not its nickname (no self-confusion)", () => {
    const A = ("0x" + "a".repeat(40)) as `0x${string}`;
    const B = ("0x" + "b".repeat(40)) as `0x${string}`;
    const names: Record<string, string> = { [A.toLowerCase()]: "Alice", [B.toLowerCase()]: "Bob" };
    const { messages } = buildDayPrompt({
      ...base,
      self: A,
      role: AgentRole.NONE,
      alive: [A, B],
      recentChat: [
        JSON.stringify({ by: A, text: "I think Bob is mafia", day: 1 }),
        JSON.stringify({ by: B, text: "no way", day: 1 }),
      ],
      nameOf: (a: string) => names[a.toLowerCase()] ?? a.slice(0, 7),
    });
    const user = messages[1];
    expect(user).toContain("You: I think Bob is mafia"); // own line marked "You"
    expect(user).toContain("Bob: no way");
    expect(user).not.toContain("Alice: I think Bob is mafia"); // not third-person self
  });

  it("uses nameOf (nicknames) for the alive list and chat lines, not raw addresses", () => {
    const A = ("0x" + "a".repeat(40)) as `0x${string}`;
    const B = ("0x" + "b".repeat(40)) as `0x${string}`;
    const names: Record<string, string> = { [A.toLowerCase()]: "Alice", [B.toLowerCase()]: "Bob" };
    const { messages } = buildDayPrompt({
      ...base,
      role: AgentRole.NONE,
      alive: [A, B],
      recentChat: [JSON.stringify({ by: B, text: "I suspect Alice", day: 1 })],
      nameOf: (a: string) => names[a.toLowerCase()] ?? a.slice(0, 7),
    });
    const user = messages[1];
    expect(user).toContain("Alice"); // alive list shows nickname
    expect(user).toContain("Bob: I suspect Alice"); // chat line uses nickname
    expect(user).not.toContain(B); // raw address absent
    expect(messages[0]).toContain("Refer to other players by their name");
  });
});

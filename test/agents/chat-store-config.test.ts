import { describe, it, expect } from "vitest";
import { hasUsableChatStore } from "../../src/agents/llm-chat-call.js";

describe("hasUsableChatStore", () => {
  it("true for testnet 50312 (built-in non-zero store)", () => {
    expect(hasUsableChatStore(50312)).toBe(true);
  });

  it("false for mainnet 5031 (zero-address default store)", () => {
    expect(hasUsableChatStore(5031)).toBe(false);
  });

  it("false for an unconfigured chain (no default, no env)", () => {
    expect(hasUsableChatStore(99999)).toBe(false);
  });
});

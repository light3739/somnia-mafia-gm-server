import { describe, it, expect } from "vitest";
import { agentTurnLockKey } from "../../src/agents/redis-keys.js";

describe("agentTurnLockKey", () => {
  it("is namespaced and unique per (chain, room, day, speakerIndex)", () => {
    expect(agentTurnLockKey(50312, "8", 1, 0)).toBe(
      "agents:turnlock:50312:8:1:0"
    );
    expect(agentTurnLockKey(50312, "8", 1, 0)).not.toBe(
      agentTurnLockKey(50312, "8", 1, 1)
    );
  });
});

/**
 * Regression: an agent registered at an HD index offset past the old fixed
 * derive window (e.g. the 6th agent in a room that already holds a human →
 * idx 6) must still be matched and driven. A fixed window of 6 (idx 0..5)
 * orphaned it → zero chat / zero vote / and, when that agent was MAFIA, the
 * dropped night kill (its silent vote starved the mafia consensus). See room 58.
 */
import { describe, it, expect } from "vitest";
import {
  deriveAgentWallet,
  matchWalletsToAgents,
  agentDeriveCount,
} from "../../src/agents/wallets.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";
const ROOM = 58n;

describe("agentDeriveCount", () => {
  it("covers offset HD indices (window > player count)", () => {
    // 7-player room: human + 6 agents at idx 1..6. The last agent (idx 6) must
    // be inside the window.
    expect(agentDeriveCount(7)).toBeGreaterThanOrEqual(7);
    expect(agentDeriveCount(7)).toBe(12);
    expect(agentDeriveCount(20)).toBe(23);
  });
});

describe("matchWalletsToAgents derive window", () => {
  it("orphans an idx-6 agent with the old fixed window of 6", () => {
    const idx6 = deriveAgentWallet({ mnemonic: MNEMONIC, roomId: ROOM, idx: 6 });
    const matched = matchWalletsToAgents(MNEMONIC, ROOM, [idx6.address], 6);
    expect(matched).toHaveLength(0); // the bug
  });

  it("matches an idx-6 agent when sized via agentDeriveCount", () => {
    const idx6 = deriveAgentWallet({ mnemonic: MNEMONIC, roomId: ROOM, idx: 6 });
    const matched = matchWalletsToAgents(
      MNEMONIC,
      ROOM,
      [idx6.address],
      agentDeriveCount(7)
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].idx).toBe(6);
    expect(matched[0].address.toLowerCase()).toBe(idx6.address.toLowerCase());
  });
});

/**
 * Unit tests for ensureAgentFunded — sponsor auto-topup for agent EOAs.
 * Pure in-process: FundingOps is faked, no chain.
 */
import { describe, it, expect } from "vitest";
import { parseEther, type Address, type Hex } from "viem";
import {
  ensureAgentFunded,
  type FundingOps,
} from "../../src/agents/agent-funding.js";

const AGENT = "0x000000000000000000000000000000000000a9e7" as Address;
const TX = ("0x" + "ab".repeat(32)) as Hex;

function makeOps(opts: {
  agentBalance: bigint;
  sponsorBalance: bigint;
}): FundingOps & { topUps: { to: Address; value: bigint }[] } {
  const topUps: { to: Address; value: bigint }[] = [];
  return {
    topUps,
    async getBalanceWei(_addr: Address) {
      return opts.agentBalance;
    },
    async getSponsorBalanceWei() {
      return opts.sponsorBalance;
    },
    async topUp(to: Address, value: bigint) {
      topUps.push({ to, value });
      return TX;
    },
  };
}

const OPTS = {
  minWei: parseEther("0.3"),
  topUpToWei: parseEther("2.5"),
  sponsorFloorWei: parseEther("1.5"),
};

describe("ensureAgentFunded", () => {
  it("does not top up when agent already at/above min", async () => {
    const ops = makeOps({ agentBalance: parseEther("1.0"), sponsorBalance: parseEther("100") });
    const res = await ensureAgentFunded(ops, AGENT, OPTS);
    expect(res.toppedUp).toBe(false);
    expect(res.funded).toBe(true);
    expect(res.reason).toBe("already-funded");
    expect(ops.topUps).toHaveLength(0);
  });

  it("tops up to target when agent below min and sponsor healthy", async () => {
    const ops = makeOps({ agentBalance: parseEther("0.1"), sponsorBalance: parseEther("100") });
    const res = await ensureAgentFunded(ops, AGENT, OPTS);
    expect(res.toppedUp).toBe(true);
    expect(res.funded).toBe(true);
    expect(res.reason).toBe("topped-up");
    expect(res.txHash).toBe(TX);
    expect(ops.topUps).toHaveLength(1);
    // Tops up the difference to reach target: 2.5 - 0.1 = 2.4.
    expect(ops.topUps[0]).toEqual({ to: AGENT, value: parseEther("2.4") });
  });

  it("refuses top-up that would drop sponsor below floor", async () => {
    // need = 2.5 - 0.1 = 2.4; sponsor 3.0 - 2.4 = 0.6 < floor 1.5 -> refuse.
    const ops = makeOps({ agentBalance: parseEther("0.1"), sponsorBalance: parseEther("3.0") });
    const res = await ensureAgentFunded(ops, AGENT, OPTS);
    expect(res.toppedUp).toBe(false);
    expect(res.funded).toBe(false);
    expect(res.reason).toBe("sponsor-floor");
    expect(ops.topUps).toHaveLength(0);
  });
});

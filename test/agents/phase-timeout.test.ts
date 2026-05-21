/**
 * Unit tests for decideKick — agent-driven phase-timeout decision.
 *
 * Mirrors what an alive player's browser does (forcePhaseTimeout at deadline),
 * but for agents. Buffer is larger than the browser stagger so an alive HUMAN
 * kicks first; agents only step in when no one advanced the phase.
 */
import { describe, it, expect, vi } from "vitest";
import {
  decideKick,
  PhaseTimeoutDriver,
  PHASE_DAY,
  PHASE_VOTING,
} from "../../src/agents/phase-timeout.js";
import { deriveAgentWallets } from "../../src/agents/wallets.js";
import type { Address } from "viem";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const ROOM = 7n;
const FLAG_ACTIVE = 0x2;

function makeFakeChain(over: any) {
  return {
    chainId: 50312,
    getRoom: vi.fn(async () => over.room),
    getPlayers: vi.fn(async () => over.players),
    isAgent: vi.fn(async (_r: bigint, a: Address) =>
      over.agentSet.has(a.toLowerCase())
    ),
    sendForcePhaseTimeout:
      over.send ?? vi.fn(async () => ("0x" + "cd".repeat(32)) as `0x${string}`),
  };
}

const A = "0x00000000000000000000000000000000000000aa" as Address;
const B = "0x00000000000000000000000000000000000000bb" as Address;

describe("decideKick", () => {
  it("kicks in DAY past deadline+buffer, electing lowest-address alive agent", () => {
    const d = decideKick({
      phase: PHASE_DAY,
      phaseDeadlineSec: 1000,
      nowSec: 1000 + 13,
      aliveAgents: [B, A],
      bufferSec: 12,
    });
    expect(d.kick).toBe(true);
    expect(d.kicker).toBe(A); // lowest address
  });

  it("kicks in VOTING past deadline+buffer", () => {
    const d = decideKick({
      phase: PHASE_VOTING,
      phaseDeadlineSec: 1000,
      nowSec: 1020,
      aliveAgents: [A],
      bufferSec: 12,
    });
    expect(d.kick).toBe(true);
    expect(d.kicker).toBe(A);
  });

  it("does NOT kick in a non-kickable phase (NIGHT=5)", () => {
    const d = decideKick({
      phase: 5,
      phaseDeadlineSec: 1000,
      nowSec: 9999,
      aliveAgents: [A],
      bufferSec: 12,
    });
    expect(d.kick).toBe(false);
    expect(d.reason).toBe("phase-not-kickable");
  });

  it("does NOT kick within buffer (defers to alive humans' browser)", () => {
    const d = decideKick({
      phase: PHASE_DAY,
      phaseDeadlineSec: 1000,
      nowSec: 1000 + 8, // past deadline but within 12s buffer
      aliveAgents: [A],
      bufferSec: 12,
    });
    expect(d.kick).toBe(false);
    expect(d.reason).toBe("within-buffer");
  });

  it("does NOT kick when we control no alive agent", () => {
    const d = decideKick({
      phase: PHASE_DAY,
      phaseDeadlineSec: 1000,
      nowSec: 2000,
      aliveAgents: [],
      bufferSec: 12,
    });
    expect(d.kick).toBe(false);
    expect(d.reason).toBe("no-alive-agent");
  });
});

describe("PhaseTimeoutDriver.tickOnce", () => {
  it("kicks via an alive agent when DAY deadline+buffer passed", async () => {
    const [agent, other] = deriveAgentWallets(TEST_MNEMONIC, ROOM, 2).map(
      (w) => w.address
    );
    const send = vi.fn(async () => ("0x" + "cd".repeat(32)) as `0x${string}`);
    const chain = makeFakeChain({
      room: { phase: PHASE_DAY, phaseDeadline: 1000, aliveCount: 2 },
      players: [
        { wallet: agent, flags: FLAG_ACTIVE },
        { wallet: other, flags: FLAG_ACTIVE },
      ],
      agentSet: new Set([agent.toLowerCase()]),
      send,
    });
    const d = new PhaseTimeoutDriver({
      chainOpsFor: () => chain as any,
      mnemonic: TEST_MNEMONIC,
      bufferSec: 12,
      nowSec: () => 1013,
    });
    const r = await d.tickOnce(50312, ROOM);
    expect(r.kicked).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does NOT kick within buffer (defers to alive human's browser)", async () => {
    const [agent] = deriveAgentWallets(TEST_MNEMONIC, ROOM, 1).map((w) => w.address);
    const send = vi.fn();
    const chain = makeFakeChain({
      room: { phase: PHASE_DAY, phaseDeadline: 1000, aliveCount: 1 },
      players: [{ wallet: agent, flags: FLAG_ACTIVE }],
      agentSet: new Set([agent.toLowerCase()]),
      send,
    });
    const d = new PhaseTimeoutDriver({
      chainOpsFor: () => chain as any,
      mnemonic: TEST_MNEMONIC,
      bufferSec: 12,
      nowSec: () => 1005,
    });
    const r = await d.tickOnce(50312, ROOM);
    expect(r.kicked).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("does NOT kick in NIGHT phase", async () => {
    const [agent] = deriveAgentWallets(TEST_MNEMONIC, ROOM, 1).map((w) => w.address);
    const send = vi.fn();
    const chain = makeFakeChain({
      room: { phase: 5, phaseDeadline: 1000, aliveCount: 1 },
      players: [{ wallet: agent, flags: FLAG_ACTIVE }],
      agentSet: new Set([agent.toLowerCase()]),
      send,
    });
    const d = new PhaseTimeoutDriver({
      chainOpsFor: () => chain as any,
      mnemonic: TEST_MNEMONIC,
      bufferSec: 12,
      nowSec: () => 5000,
    });
    const r = await d.tickOnce(50312, ROOM);
    expect(r.kicked).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

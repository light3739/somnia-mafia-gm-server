/**
 * Unit tests for HeadlessDayDriver — the agent-driven DAY discussion start.
 *
 * The DAY discussion (and thus agent chat) is normally orchestrated by an ALIVE
 * human's browser: it POSTs /discussion start and polls GET /discussion to
 * advance the speaker rotation, which lets agents speak via turnController. When
 * the last human dies (or an all-agent game), no browser drives it → the room
 * sits on "Waiting for discussion to start..." until the phase-timeout kicks.
 *
 * HeadlessDayDriver fills that gap: on DAY_STARTED with no alive human, the GM
 * starts the discussion server-side, drives the agent turns to completion, then
 * an alive agent starts voting early (no dead tail). Mixed games (any alive
 * human) are left to the proven browser path.
 */
import { describe, it, expect, vi } from "vitest";
import { HeadlessDayDriver } from "../../src/agents/headless-day.js";
import { deriveAgentWallets } from "../../src/agents/wallets.js";
import type { Address, Hex } from "viem";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const ROOM = 7n;
const ROOM_STR = "7";
const FLAG_ACTIVE = 0x2;
const PHASE_DAY = 3;
const PHASE_VOTING = 4;
const TX: Hex = ("0x" + "ab".repeat(32)) as Hex;

const HUMAN = "0x00000000000000000000000000000000000000aa" as Address;
const FOREIGN_AGENT = "0x00000000000000000000000000000000000000bb" as Address;

function twoOwnAgents(): Address[] {
  return deriveAgentWallets(TEST_MNEMONIC, ROOM, 2).map((w) => w.address);
}

function makeChain(over: {
  rooms: Array<{ phase: number; dayCount: number; aliveCount: number }>;
  players: Array<{ wallet: Address; flags: number }>;
  agentSet: Set<string>;
  sendStartVoting?: ReturnType<typeof vi.fn>;
}) {
  const getRoom = vi.fn();
  for (const r of over.rooms) getRoom.mockResolvedValueOnce(r);
  // After the scripted sequence, keep returning the last room snapshot.
  getRoom.mockResolvedValue(over.rooms[over.rooms.length - 1]);
  return {
    chainId: 50312,
    getRoom,
    getPlayers: vi.fn(async () => over.players),
    isAgent: vi.fn(async (_r: bigint, a: Address) =>
      over.agentSet.has(a.toLowerCase())
    ),
    sendStartVoting:
      over.sendStartVoting ?? vi.fn(async () => TX),
  };
}

function makeDriver(chain: any, depsOver: any = {}) {
  const deps = {
    chainOpsFor: () => chain,
    mnemonic: TEST_MNEMONIC,
    startDiscussion: vi.fn(async () => {}),
    driveTurns: vi.fn(async () => {}),
    claimOnce: vi.fn(async () => true),
    gasPriceGwei: 10,
    dayEnabled: true,
    ...depsOver,
  };
  return { driver: new HeadlessDayDriver(deps), deps };
}

describe("HeadlessDayDriver.onDayStarted", () => {
  it("headless (all alive are our agents): starts discussion, drives turns, then starts voting early", async () => {
    const [a1, a2] = twoOwnAgents();
    const { driver, deps } = makeDriver(
      makeChain({
        rooms: [
          { phase: PHASE_DAY, dayCount: 2, aliveCount: 2 }, // entry
          { phase: PHASE_DAY, dayCount: 2, aliveCount: 2 }, // recheck before startVoting
        ],
        players: [
          { wallet: a1, flags: FLAG_ACTIVE },
          { wallet: a2, flags: FLAG_ACTIVE },
        ],
        agentSet: new Set([a1.toLowerCase(), a2.toLowerCase()]),
      })
    );

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(r.driven).toBe(true);
    expect(deps.startDiscussion).toHaveBeenCalledWith(50312, ROOM_STR, 2);
    expect(deps.driveTurns).toHaveBeenCalledWith(50312, ROOM_STR, 2);
    expect(deps.driveTurns).toHaveBeenCalledTimes(1);
    // startVoting fired exactly once with the room id.
    const chain = deps.chainOpsFor();
    expect(chain.sendStartVoting).toHaveBeenCalledTimes(1);
    expect(chain.sendStartVoting.mock.calls[0][1]).toBe(ROOM);
  });

  it("mixed (an alive human present): does nothing — browser drives", async () => {
    const [a1] = twoOwnAgents();
    const { driver, deps } = makeDriver(
      makeChain({
        rooms: [{ phase: PHASE_DAY, dayCount: 1, aliveCount: 2 }],
        players: [
          { wallet: a1, flags: FLAG_ACTIVE },
          { wallet: HUMAN, flags: FLAG_ACTIVE },
        ],
        agentSet: new Set([a1.toLowerCase()]), // HUMAN is not an agent
      })
    );

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(r.driven).toBe(false);
    expect(r.reason).toBe("humans-present");
    expect(deps.claimOnce).not.toHaveBeenCalled();
    expect(deps.startDiscussion).not.toHaveBeenCalled();
    expect(deps.driveTurns).not.toHaveBeenCalled();
  });

  it("all-agent but none are OURS: does nothing (no-agents)", async () => {
    const { driver, deps } = makeDriver(
      makeChain({
        rooms: [{ phase: PHASE_DAY, dayCount: 1, aliveCount: 1 }],
        players: [{ wallet: FOREIGN_AGENT, flags: FLAG_ACTIVE }],
        agentSet: new Set([FOREIGN_AGENT.toLowerCase()]),
      })
    );

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(r.driven).toBe(false);
    expect(r.reason).toBe("no-agents");
    expect(deps.startDiscussion).not.toHaveBeenCalled();
  });

  it("day chat disabled: does nothing", async () => {
    const [a1] = twoOwnAgents();
    const { driver, deps } = makeDriver(
      makeChain({
        rooms: [{ phase: PHASE_DAY, dayCount: 1, aliveCount: 1 }],
        players: [{ wallet: a1, flags: FLAG_ACTIVE }],
        agentSet: new Set([a1.toLowerCase()]),
      }),
      { dayEnabled: false }
    );

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(r.driven).toBe(false);
    expect(r.reason).toBe("day-disabled");
    expect(deps.startDiscussion).not.toHaveBeenCalled();
  });

  it("not in DAY phase: does nothing", async () => {
    const [a1] = twoOwnAgents();
    const { driver, deps } = makeDriver(
      makeChain({
        rooms: [{ phase: PHASE_VOTING, dayCount: 1, aliveCount: 1 }],
        players: [{ wallet: a1, flags: FLAG_ACTIVE }],
        agentSet: new Set([a1.toLowerCase()]),
      })
    );

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(r.driven).toBe(false);
    expect(r.reason).toBe("not-day");
    expect(deps.startDiscussion).not.toHaveBeenCalled();
  });

  it("claim lost (already driven this day): does nothing after detection", async () => {
    const [a1, a2] = twoOwnAgents();
    const { driver, deps } = makeDriver(
      makeChain({
        rooms: [{ phase: PHASE_DAY, dayCount: 3, aliveCount: 2 }],
        players: [
          { wallet: a1, flags: FLAG_ACTIVE },
          { wallet: a2, flags: FLAG_ACTIVE },
        ],
        agentSet: new Set([a1.toLowerCase(), a2.toLowerCase()]),
      }),
      { claimOnce: vi.fn(async () => false) }
    );

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(r.driven).toBe(false);
    expect(r.reason).toBe("already-claimed");
    expect(deps.claimOnce).toHaveBeenCalledWith(50312, ROOM_STR, 3);
    expect(deps.startDiscussion).not.toHaveBeenCalled();
    expect(deps.driveTurns).not.toHaveBeenCalled();
  });

  it("phase advanced during the turn drive: does NOT start voting", async () => {
    const [a1, a2] = twoOwnAgents();
    const chain = makeChain({
      rooms: [
        { phase: PHASE_DAY, dayCount: 1, aliveCount: 2 }, // entry
        { phase: PHASE_VOTING, dayCount: 1, aliveCount: 2 }, // recheck: already advanced
      ],
      players: [
        { wallet: a1, flags: FLAG_ACTIVE },
        { wallet: a2, flags: FLAG_ACTIVE },
      ],
      agentSet: new Set([a1.toLowerCase(), a2.toLowerCase()]),
    });
    const { driver, deps } = makeDriver(chain);

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(deps.driveTurns).toHaveBeenCalledTimes(1);
    expect(chain.sendStartVoting).not.toHaveBeenCalled();
    expect(r.driven).toBe(true);
    expect(r.reason).toBe("phase-advanced");
  });

  it("startVoting reverts (someone else advanced): still reports driven (chat happened)", async () => {
    const [a1, a2] = twoOwnAgents();
    const sendStartVoting = vi.fn(async () => {
      throw new Error("WrongPhase");
    });
    const chain = makeChain({
      rooms: [
        { phase: PHASE_DAY, dayCount: 1, aliveCount: 2 },
        { phase: PHASE_DAY, dayCount: 1, aliveCount: 2 },
      ],
      players: [
        { wallet: a1, flags: FLAG_ACTIVE },
        { wallet: a2, flags: FLAG_ACTIVE },
      ],
      agentSet: new Set([a1.toLowerCase(), a2.toLowerCase()]),
      sendStartVoting,
    });
    const { driver } = makeDriver(chain);

    const r = await driver.onDayStarted({ chainId: 50312, roomId: ROOM_STR });

    expect(sendStartVoting).toHaveBeenCalledTimes(1);
    expect(r.driven).toBe(true); // discussion still ran; voting-start revert is benign
  });
});

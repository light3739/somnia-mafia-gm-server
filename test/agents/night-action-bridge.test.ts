import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

vi.mock("../../src/chain.js", () => ({
  FLAGS: { ACTIVE: 0x2 },
  getPlayers: vi.fn(),
}));

vi.mock("../../src/routes/nightRoutes.js", () => ({
  resolveNightWithFloor: vi.fn(async () => undefined),
  ensureNightTimeout: vi.fn(),
}));

const { getPlayers } = await import("../../src/chain.js");
const { resolveNightWithFloor, ensureNightTimeout } = await import("../../src/routes/nightRoutes.js");
const { recordAgentNightAction } = await import("../../src/agents/night-action-bridge.js");

import { clearNightState, getNightState } from "../../src/game-state.js";
import { GMStore } from "../../src/stores/index.js";
import { Role } from "../../src/types/contract.js";
import { agentMemoryKey } from "../../src/agents/redis-keys.js";

class FakeRedis {
  kv = new Map<string, string>();

  async set(key: string, value: string): Promise<"OK"> {
    this.kv.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
}

const CHAIN_ID = 50312;
const ROOM_ID = "77";
const MAFIA = "0x0000000000000000000000000000000000000001" as Address;
const DOCTOR = "0x0000000000000000000000000000000000000002" as Address;
const DETECTIVE = "0x0000000000000000000000000000000000000003" as Address;
const CITIZEN = "0x0000000000000000000000000000000000000004" as Address;

describe("recordAgentNightAction", () => {
  let store: GMStore;
  let redis: FakeRedis;

  beforeEach(() => {
    vi.clearAllMocks();
    clearNightState(BigInt(ROOM_ID));
    store = new GMStore();
    redis = new FakeRedis();
  });

  it("records agent action into GM night state and triggers resolve when role actors are done", async () => {
    store.resolvedRoles.set(
      store.getRoomKey(CHAIN_ID, ROOM_ID),
      new Map([
        [MAFIA.toLowerCase(), Role.MAFIA],
        [CITIZEN.toLowerCase(), Role.CITIZEN],
      ])
    );
    (getPlayers as any).mockResolvedValue([
      { wallet: MAFIA, flags: 0x2 },
      { wallet: CITIZEN, flags: 0x2 },
    ]);

    const result = await recordAgentNightAction(
      {
        chainId: CHAIN_ID,
        roomId: ROOM_ID,
        dayCount: 1,
        playerAddress: MAFIA,
        actionType: "kill",
        targetAddress: CITIZEN,
      },
      { store, redis: redis as any }
    );

    expect(result.recorded).toBe(true);
    expect(result.resolvedTriggered).toBe(true);
    const state = getNightState(BigInt(ROOM_ID));
    expect(state?.actions.get(MAFIA.toLowerCase())?.actionType).toBe("kill");
    expect(state?.actions.get(MAFIA.toLowerCase())?.targetAddress).toBe(CITIZEN);
    expect(resolveNightWithFloor).toHaveBeenCalledTimes(1);
    expect(ensureNightTimeout).not.toHaveBeenCalled();
  });

  it("writes detective check result into private agent memory", async () => {
    store.resolvedRoles.set(
      store.getRoomKey(CHAIN_ID, ROOM_ID),
      new Map([
        [DETECTIVE.toLowerCase(), Role.DETECTIVE],
        [MAFIA.toLowerCase(), Role.MAFIA],
        [DOCTOR.toLowerCase(), Role.DOCTOR],
      ])
    );
    (getPlayers as any).mockResolvedValue([
      { wallet: DETECTIVE, flags: 0x2 },
      { wallet: MAFIA, flags: 0x2 },
      { wallet: DOCTOR, flags: 0x2 },
    ]);

    const result = await recordAgentNightAction(
      {
        chainId: CHAIN_ID,
        roomId: ROOM_ID,
        dayCount: 2,
        playerAddress: DETECTIVE,
        actionType: "check",
        targetAddress: MAFIA,
      },
      { store, redis: redis as any }
    );

    expect(result.recorded).toBe(true);
    expect(result.memoryWritten).toBe(true);
    const memoryRaw = await redis.get(agentMemoryKey(CHAIN_ID, ROOM_ID, DETECTIVE));
    expect(memoryRaw).not.toBeNull();
    const memory = JSON.parse(memoryRaw!);
    expect(memory.facts[0]).toMatchObject({
      type: "investigation",
      day: 2,
      target: MAFIA,
      role: Role.MAFIA,
      roleLabel: "Mafia",
    });
    const proof = store.investigationProofs
      .get(store.getRoomKey(CHAIN_ID, ROOM_ID))
      ?.get(DETECTIVE.toLowerCase());
    expect(proof?.targetAddress).toBe(MAFIA);
  });
});

/**
 * Unit tests for fillRoomWithAgents.
 *
 * Strategy: inject a fake FillChainAccess via deps.chainAccessOverride so no
 * real viem clients are created — every chain read and write is a vi.fn().
 * Sponsor + signJoinPermit are stubbed via vi.mock since they're module-level.
 *
 * Coverage:
 *   - preflight: room not LOBBY → throws
 *   - preflight: capacity exceeded → throws
 *   - preflight: sponsor balance insufficient → throws
 *   - happy 2 agents: every phase fires, outcomes all "filled"
 *   - idempotency: agent already in room is skipped without any tx
 *   - top-up failure for one agent: that slot marked topup-failed, others fill
 *   - joinRoom failure for one agent: that slot marked join-failed; register skipped
 *   - registerAgent failure for one agent: slot marked register-failed; join still recorded
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { parseEther, type Address, type Hex } from "viem";

vi.mock("../../src/agents/sponsor.js", () => ({
  topUp: vi.fn(),
  getSponsorAddress: vi.fn(() => "0x9999999999999999999999999999999999999999"),
  getSponsorBalance: vi.fn(),
}));

vi.mock("../../src/chain.js", () => ({
  signJoinPermit: vi.fn(async () => "0xdeadbeef" as Hex),
  // Stub so any incidental import doesn't crash; tests override via deps.
  getChainConfig: vi.fn(() => {
    throw new Error("getChainConfig should be unreachable in tests");
  }),
}));

import {
  fillRoomWithAgents,
  type FillChainAccess,
} from "../../src/agents/fill-room.js";
import * as sponsorMod from "../../src/agents/sponsor.js";
import { deriveAgentWallet } from "../../src/agents/wallets.js";
import { agentFillRoomLockKey } from "../../src/agents/redis-keys.js";

// ── Fake redis ─────────────────────────────────────────────────────────────
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, ...args: any[]): Promise<"OK" | null> {
    let nx = false;
    let exSeconds: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "NX") nx = true;
      if (a === "EX") exSeconds = Number(args[i + 1]);
    }
    const existing = this.store.get(key);
    const now = Date.now();
    const alive = existing && (existing.expiresAt == null || existing.expiresAt > now);
    if (nx && alive) return null;
    this.store.set(key, {
      value,
      expiresAt: exSeconds != null ? now + exSeconds * 1000 : null,
    });
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    if (!v) return null;
    if (v.expiresAt != null && v.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return v.value;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

// ── Chain state + mocks ────────────────────────────────────────────────────
interface ChainState {
  room: { phase: number; playersCount: number; maxPlayers: number; depositPerPlayer: bigint };
  entryFee: bigint;
  existingPlayers: { wallet: string }[];
  /** addresses registered in AgentRegistryFacet.isAgent */
  registeredAgents?: Set<string>;
  /** keyed by lowercase agent addr; throws given error from joinRoom */
  joinFailures?: Map<string, string>;
  /** keyed by lowercase agent addr; throws given error from registerAgent */
  registerFailures?: Map<string, string>;
  /**
   * Override receipt.status for a specific tx hash returned by mocked writes.
   * Used to simulate a tx that was MINED but REVERTED — distinct from the
   * tx-call throwing (network failure / nonce error). Default 'success'.
   */
  receiptStatusByHash?: Map<string, string>;
}

const DIAMOND: Address = "0xdddddddddddddddddddddddddddddddddddddddd";

function buildFakeChainAccess(state: ChainState): {
  access: FillChainAccess;
  spies: {
    readContract: Mock;
    gmWrite: Mock;
    agentWritesByAddr: Map<string, Mock>;
    waitForReceipt: Mock;
  };
} {
  const readContract = vi.fn(async ({ functionName, args }: any) => {
    switch (functionName) {
      case "getRoom":
        return state.room;
      case "getPlayers":
        return state.existingPlayers;
      case "getEntryFee":
        return state.entryFee;
      case "isAgent":
        return state.registeredAgents?.has(String(args[1]).toLowerCase()) ?? false;
      default:
        throw new Error(`unmocked readContract: ${functionName}`);
    }
  });

  const waitForReceipt = vi.fn(async ({ hash }: any) => {
    const override = state.receiptStatusByHash?.get(String(hash).toLowerCase());
    return { status: override ?? "success" };
  });

  const gmWrite = vi.fn(async ({ functionName, args }: any) => {
    if (functionName !== "registerAgent") {
      throw new Error(`gmWalletClient.writeContract unsupported fn: ${functionName}`);
    }
    const target = String(args[1]).toLowerCase();
    const failure = state.registerFailures?.get(target);
    if (failure) throw new Error(failure);
    return `0xb0b${target.slice(2, 12)}${"0".repeat(48)}` as Hex;
  });

  const agentWritesByAddr = new Map<string, Mock>();

  // getBalance default: 0 for agent addresses. fill-room.ts uses this to decide
  // whether to skip a redundant top-up. Tests that need a non-zero pre-balance
  // can override after construction.
  const publicClient: any = {
    chain: {
      id: 50312,
      rpcUrls: { default: { http: ["http://rpc.test"] } },
    },
    readContract,
    waitForTransactionReceipt: waitForReceipt,
    getBalance: vi.fn(async () => 0n),
  };

  const gmWalletClient: any = { writeContract: gmWrite };

  const access: FillChainAccess = {
    publicClient,
    gmWalletClient,
    diamond: DIAMOND,
    buildAgentWalletClient(agent) {
      const addr = agent.address.toLowerCase();
      let mock = agentWritesByAddr.get(addr);
      if (!mock) {
        mock = vi.fn(async ({ functionName }: any) => {
          if (functionName !== "joinRoom") {
            throw new Error(`agent walletClient unsupported fn: ${functionName}`);
          }
          const failure = state.joinFailures?.get(addr);
          if (failure) throw new Error(failure);
          return `0xa11ce${addr.slice(2, 10)}${"0".repeat(50)}` as Hex;
        });
        agentWritesByAddr.set(addr, mock);
      }
      return { writeContract: mock } as any;
    },
  };

  return { access, spies: { readContract, gmWrite, agentWritesByAddr, waitForReceipt } };
}

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

function resetMocks() {
  vi.mocked(sponsorMod.topUp).mockReset();
  vi.mocked(sponsorMod.getSponsorBalance).mockReset();
  vi.mocked(sponsorMod.getSponsorAddress).mockReset();
  vi.mocked(sponsorMod.getSponsorAddress).mockReturnValue(
    "0x9999999999999999999999999999999999999999"
  );
}

function defaultSponsor(opts: { balance?: bigint } = {}) {
  vi.mocked(sponsorMod.getSponsorBalance).mockResolvedValue(
    opts.balance ?? parseEther("1000")
  );
  vi.mocked(sponsorMod.topUp).mockImplementation(
    async (_chainId: number, to: any) =>
      ("0x70075" + String(to).slice(2, 12) + "0".repeat(47)) as Hex
  );
}

describe("fillRoomWithAgents", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    resetMocks();
  });

  it("throws when room is not in LOBBY phase", async () => {
    defaultSponsor();
    const { access } = buildFakeChainAccess({
      room: {
        phase: 3,
        playersCount: 2,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });
    await expect(
      fillRoomWithAgents(
        { chainId: 50312, roomId: 1n, agentCount: 2 },
        {
          redis: redis as any,
          loadMnemonic: () => TEST_MNEMONIC,
          chainAccessOverride: access,
        }
      )
    ).rejects.toThrow(/LOBBY/);
  });

  it("throws when room cannot fit the requested agent count", async () => {
    defaultSponsor();
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 5,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });
    await expect(
      fillRoomWithAgents(
        { chainId: 50312, roomId: 1n, agentCount: 2 },
        {
          redis: redis as any,
          loadMnemonic: () => TEST_MNEMONIC,
          chainAccessOverride: access,
        }
      )
    ).rejects.toThrow(/can fit only 1 more agent/);
  });

  it("throws when sponsor balance is insufficient", async () => {
    defaultSponsor({ balance: 1n });
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });
    await expect(
      fillRoomWithAgents(
        { chainId: 50312, roomId: 1n, agentCount: 2 },
        {
          redis: redis as any,
          loadMnemonic: () => TEST_MNEMONIC,
          chainAccessOverride: access,
        }
      )
    ).rejects.toThrow(/sponsor balance/);
  });

  it("happy path 2 agents: top-up x2, join x2, register x2 → all filled", async () => {
    defaultSponsor();
    const { access, spies } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 2 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.status === "filled")).toBe(true);
    expect(vi.mocked(sponsorMod.topUp)).toHaveBeenCalledTimes(2);
    expect(spies.gmWrite).toHaveBeenCalledTimes(2); // registerAgent x2
    expect(spies.agentWritesByAddr.size).toBe(2); // 2 separate agent wallets used

    for (const o of result.outcomes) {
      if (o.status !== "filled") continue;
      expect(o.topUpTxHash).toMatch(/^0x70075/);
      expect(o.joinTxHash).toMatch(/^0xa11ce/);
      expect(o.registerTxHash).toMatch(/^0xb0b/);
      expect(o.eciesPubHex.length).toBe(130);
    }
  });

  it("idempotency: agents already in room are skipped without any tx", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0, // start fresh; w0 already in existingPlayers triggers skip
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [{ wallet: w0.address }],
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 2 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    const skipped = result.outcomes.find(
      (o) => o.status === "skipped-already-in-room"
    );
    expect(skipped?.agent.toLowerCase()).toBe(w0.address.toLowerCase());
    expect(result.outcomes.some((o) => o.status === "filled")).toBe(true);
    expect(vi.mocked(sponsorMod.topUp)).toHaveBeenCalledTimes(1);
  });

  it("targeted fill is a no-op once the room already has the target agent count", async () => {
    defaultSponsor();
    const agents = [0, 1, 2].map((idx) =>
      deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx })
    );
    const { access, spies } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 4,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [
        { wallet: "0x1111111111111111111111111111111111111111" },
        ...agents.map((w) => ({ wallet: w.address })),
      ],
      registeredAgents: new Set(agents.map((w) => w.address.toLowerCase())),
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 3, maxAgentsInRoom: 3 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    expect(result.agentsInRoomBefore).toBe(3);
    expect(result.agentsToAdd).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(vi.mocked(sponsorMod.topUp)).not.toHaveBeenCalled();
    expect(spies.gmWrite).not.toHaveBeenCalled();
  });

  it("targeted fill adds only the missing agents up to the target", async () => {
    defaultSponsor();
    const existingAgents = [0, 1].map((idx) =>
      deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx })
    );
    const { access, spies } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 3,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [
        { wallet: "0x1111111111111111111111111111111111111111" },
        ...existingAgents.map((w) => ({ wallet: w.address })),
      ],
      registeredAgents: new Set(existingAgents.map((w) => w.address.toLowerCase())),
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 3, maxAgentsInRoom: 3 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    expect(result.agentsInRoomBefore).toBe(2);
    expect(result.agentsToAdd).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("filled");
    expect(vi.mocked(sponsorMod.topUp)).toHaveBeenCalledTimes(1);
    expect(spies.gmWrite).toHaveBeenCalledTimes(1);
  });

  it("room-level fill lock rejects a second fill while one is already running", async () => {
    await redis.set(agentFillRoomLockKey(50312, "1"), "other", "EX", 900, "NX");
    defaultSponsor();
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });

    await expect(
      fillRoomWithAgents(
        { chainId: 50312, roomId: 1n, agentCount: 3, maxAgentsInRoom: 3 },
        {
          redis: redis as any,
          loadMnemonic: () => TEST_MNEMONIC,
          chainAccessOverride: access,
        }
      )
    ).rejects.toThrow(/already in progress/);
    expect(vi.mocked(sponsorMod.topUp)).not.toHaveBeenCalled();
  });

  it("top-up failure for one agent: slot marked topup-failed, others fill", async () => {
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    vi.mocked(sponsorMod.getSponsorBalance).mockResolvedValue(parseEther("1000"));
    vi.mocked(sponsorMod.topUp).mockImplementation(
      async (_chainId: number, to: any) => {
        if (String(to).toLowerCase() === w0.address.toLowerCase()) {
          throw new Error("insufficient gas");
        }
        return ("0x70075" + String(to).slice(2, 12) + "0".repeat(47)) as Hex;
      }
    );
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 2 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    const o0 = result.outcomes.find(
      (o) => o.agent.toLowerCase() === w0.address.toLowerCase()
    );
    expect(o0?.status).toBe("topup-failed");
    expect(result.outcomes.some((o) => o.status === "filled")).toBe(true);
  });

  it("joinRoom failure for one agent: slot marked join-failed; register skipped for it", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    const { access, spies } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
      joinFailures: new Map([
        [w0.address.toLowerCase(), "execution reverted: RoomFull"],
      ]),
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 2 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    const o0 = result.outcomes.find(
      (o) => o.agent.toLowerCase() === w0.address.toLowerCase()
    );
    expect(o0?.status).toBe("join-failed");
    if (o0?.status === "join-failed") {
      expect(o0.err).toContain("RoomFull");
      expect(o0.topUpTxHash).toBeDefined();
    }
    expect(result.outcomes.some((o) => o.status === "filled")).toBe(true);
    // GM only registered the successfully-joined agent (1 call, not 2)
    expect(spies.gmWrite).toHaveBeenCalledTimes(1);
  });

  it("registerAgent failure for one agent: slot marked register-failed; join still recorded", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
      registerFailures: new Map([
        [w0.address.toLowerCase(), "execution reverted: NotGM"],
      ]),
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 2 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    const o0 = result.outcomes.find(
      (o) => o.agent.toLowerCase() === w0.address.toLowerCase()
    );
    expect(o0?.status).toBe("register-failed");
    if (o0?.status === "register-failed") {
      expect(o0.joinTxHash).toMatch(/^0xa11ce/);
      expect(o0.topUpTxHash).toBeDefined();
      expect(o0.err).toContain("NotGM");
    }
    expect(result.outcomes.some((o) => o.status === "filled")).toBe(true);
  });

  // ── Review-finding regression tests ───────────────────────────────────

  it("joinRoom mined-but-reverted receipt → join-failed (not silently filled)", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    // The agent walletClient's writeContract resolves with this hash; the
    // receipt mock then reports status=reverted. Pre-fix this passed silently.
    const revertedHash = (`0xa11ce${w0.address.slice(2, 10).toLowerCase()}${"0".repeat(50)}`).toLowerCase();
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
      receiptStatusByHash: new Map([[revertedHash, "reverted"]]),
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 1 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    expect(result.outcomes[0].status).toBe("join-failed");
    if (result.outcomes[0].status === "join-failed") {
      expect(result.outcomes[0].err).toContain("reverted");
    }
  });

  it("registerAgent mined-but-reverted receipt → register-failed", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    // The GM mock returns this register hash; receipt mock reports reverted.
    const regRevertedHash = (`0xb0b${w0.address.slice(2, 12).toLowerCase()}${"0".repeat(48)}`).toLowerCase();
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
      receiptStatusByHash: new Map([[regRevertedHash, "reverted"]]),
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 1 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    expect(result.outcomes[0].status).toBe("register-failed");
  });

  it("join failure releases action key — retry succeeds (no 7-day lockout)", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });

    // First run: joinRoom throws (e.g. transient network).
    const failState: ChainState = {
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
      joinFailures: new Map([[w0.address.toLowerCase(), "ECONNRESET"]]),
    };
    const { access: failAccess } = buildFakeChainAccess(failState);
    const firstResult = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 1 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: failAccess,
      }
    );
    expect(firstResult.outcomes[0].status).toBe("join-failed");

    // Second run with a fresh access (no joinFailures). Pre-fix the action
    // key stayed claimed → retry would mark "join-failed: action key already
    // held" and never re-attempt. Post-fix the key was released so this
    // retry must reach "filled".
    const { access: successAccess } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });
    const retryResult = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 1 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: successAccess,
      }
    );
    expect(retryResult.outcomes[0].status).toBe("filled");
  });

  it("PRE_FUNDED agent: topUpTxHash = null (not a phantom zero hash)", async () => {
    defaultSponsor();
    const w0 = deriveAgentWallet({ mnemonic: TEST_MNEMONIC, roomId: 1n, idx: 0 });
    const { access } = buildFakeChainAccess({
      room: {
        phase: 0,
        playersCount: 0,
        maxPlayers: 6,
        depositPerPlayer: parseEther("0.01"),
      },
      entryFee: 0n,
      existingPlayers: [],
    });
    // Mark this agent as already funded — fill-room should skip top-up entirely.
    (access.publicClient as any).getBalance = vi.fn(async ({ address }: any) => {
      if (String(address).toLowerCase() === w0.address.toLowerCase()) {
        return parseEther("100");
      }
      return 0n;
    });

    const result = await fillRoomWithAgents(
      { chainId: 50312, roomId: 1n, agentCount: 1 },
      {
        redis: redis as any,
        loadMnemonic: () => TEST_MNEMONIC,
        chainAccessOverride: access,
      }
    );

    expect(result.outcomes[0].status).toBe("filled");
    if (result.outcomes[0].status === "filled") {
      expect(result.outcomes[0].topUpTxHash).toBeNull();
    }
    // sponsor.topUp was never called for the pre-funded agent
    expect(vi.mocked(sponsorMod.topUp)).not.toHaveBeenCalled();
  });
});

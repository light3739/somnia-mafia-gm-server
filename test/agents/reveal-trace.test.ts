import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildPhaseLabelMap,
  revealRoomTraces,
  type RevealDeps,
} from "../../src/agents/reveal-trace.js";
import { makePhaseId } from "../../src/agents/trace.js";

describe("buildPhaseLabelMap", () => {
  it("maps each keccak phaseId back to its D{day}-{KIND} label", () => {
    const map = buildPhaseLabelMap(2);
    expect(map.get(makePhaseId("NIGHT", 1).toLowerCase())).toBe("D1-NIGHT");
    expect(map.get(makePhaseId("VOTING", 2).toLowerCase())).toBe("D2-VOTING");
    expect(map.get(makePhaseId("DAY", 1).toLowerCase())).toBe("D1-DAY");
    expect(map.size).toBe(6); // 2 days x 3 kinds
  });

  it("clamps dayCount<1 to at least day 1", () => {
    expect(buildPhaseLabelMap(0).size).toBe(3);
  });
});

const AGENT = "0x00000000000000000000000000000000000000a1" as `0x${string}`;

function baseDeps(over: Partial<RevealDeps> = {}): RevealDeps {
  return {
    getRoom: vi.fn().mockResolvedValue({ phase: 6, dayCount: 1 }), // ENDED
    getCommittedSlots: vi.fn().mockResolvedValue([]),
    getRevealedKeys: vi.fn().mockResolvedValue(new Set<string>()),
    getTrace: vi.fn().mockResolvedValue(null),
    claimRevealRun: vi.fn().mockResolvedValue(true),
    sendReveal: vi.fn().mockResolvedValue("0xtx"),
    ...over,
  };
}

describe("revealRoomTraces — guards", () => {
  it("disabled when AGENTS_ENABLED!=true", async () => {
    const prev = process.env.AGENTS_ENABLED; process.env.AGENTS_ENABLED = "false";
    const deps = baseDeps();
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    process.env.AGENTS_ENABLED = prev;
    expect(r.status).toBe("disabled");
    expect(deps.getRoom).not.toHaveBeenCalled();
  });

  it("room-not-ended when phase != 6", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({ getRoom: vi.fn().mockResolvedValue({ phase: 5, dayCount: 1 }) });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.status).toBe("room-not-ended");
    expect(deps.claimRevealRun).not.toHaveBeenCalled();
  });

  it("already-claimed when the run-claim is held", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({ claimRevealRun: vi.fn().mockResolvedValue(false) });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.status).toBe("already-claimed");
    expect(deps.getCommittedSlots).not.toHaveBeenCalled();
  });
});

const NIGHT1 = makePhaseId("NIGHT", 1);
const VOTE1 = makePhaseId("VOTING", 1);
const AH = "0x00000000000000000000000000000000000000000000000000000000000000ab" as `0x${string}`;

function goodTrace() {
  return {
    salt: "0x" + "ab".repeat(32),
    somniaRequestId: "12847293847561029384",
    promptHash: "0x" + "cd".repeat(32),
    responseHash: "0x" + "ef".repeat(32),
    actionHash: AH,
  };
}

describe("revealRoomTraces — per-slot", () => {
  beforeEach(() => { process.env.AGENTS_ENABLED = "true"; });

  it("happy path: reveals each committed slot, passes keccak phaseId + BigInt reqId", async () => {
    const deps = baseDeps({
      getRoom: vi.fn().mockResolvedValue({ phase: 6, dayCount: 1 }),
      getCommittedSlots: vi.fn().mockResolvedValue([
        { phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH },
      ]),
      getTrace: vi.fn().mockResolvedValue(goodTrace()),
      sendReveal: vi.fn().mockResolvedValue("0xrevealtx"),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.revealed).toBe(1);
    expect(r.txHashes).toEqual(["0xrevealtx"]);
    expect(deps.getTrace).toHaveBeenCalledWith("D1-NIGHT", AGENT);
    expect(deps.sendReveal).toHaveBeenCalledWith(expect.objectContaining({
      phaseIdHex: NIGHT1,
      somniaRequestId: 12847293847561029384n,
    }));
  });

  it("skips already-revealed slots", async () => {
    const key = `${AGENT.toLowerCase()}:${NIGHT1.toLowerCase()}:${AH.toLowerCase()}`;
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getRevealedKeys: vi.fn().mockResolvedValue(new Set([key])),
      getTrace: vi.fn().mockResolvedValue(goodTrace()),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.revealed).toBe(0);
    expect(deps.sendReveal).not.toHaveBeenCalled();
  });

  it("skips unknown-phase (keccak not in the day map)", async () => {
    const bogus = ("0x" + "99".repeat(32)) as `0x${string}`;
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: bogus, agent: AGENT, actionHash: AH }]),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped).toEqual([{ agent: AGENT, phaseIdHex: bogus, reason: "unknown-phase" }]);
    expect(deps.getTrace).not.toHaveBeenCalled();
  });

  it("skips trace-expired (Redis miss)", async () => {
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getTrace: vi.fn().mockResolvedValue(null),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped[0].reason).toBe("trace-expired");
    expect(deps.sendReveal).not.toHaveBeenCalled();
  });

  it("skips trace-incomplete (missing field)", async () => {
    const { promptHash, ...partial } = goodTrace();
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getTrace: vi.fn().mockResolvedValue(partial),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped[0].reason).toBe("trace-incomplete");
  });

  it("skips actionhash-mismatch", async () => {
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([{ phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH }]),
      getTrace: vi.fn().mockResolvedValue({ ...goodTrace(), actionHash: "0x" + "00".repeat(32) }),
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.skipped[0].reason).toBe("actionhash-mismatch");
  });

  it("partial failure: one reveal throws, the rest still process", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("revert"))
      .mockResolvedValueOnce("0xok");
    const deps = baseDeps({
      getCommittedSlots: vi.fn().mockResolvedValue([
        { phaseIdHex: NIGHT1, agent: AGENT, actionHash: AH },
        { phaseIdHex: VOTE1, agent: AGENT, actionHash: AH },
      ]),
      getTrace: vi.fn().mockResolvedValue(goodTrace()),
      sendReveal: send,
    });
    const r = await revealRoomTraces({ chainId: 50312, roomId: "72" }, deps);
    expect(r.total).toBe(2);
    expect(r.revealed).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toContain("revert");
  });
});

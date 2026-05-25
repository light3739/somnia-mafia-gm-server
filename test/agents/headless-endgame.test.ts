import { describe, it, expect, vi } from "vitest";
import { maybeFinalizeHeadlessWin } from "../../src/agents/headless-endgame.js";
import { Role } from "../../src/types/contract.js";

const FLAG_ACTIVE = 0x2;
const mafia = "0xMAFIA", townA = "0xTOWNA", human = "0xHUMAN";

function baseDeps(over: any = {}) {
  return {
    redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn() },
    getRoom: vi.fn().mockResolvedValue({ phase: 5 }), // NIGHT
    getPlayers: vi.fn().mockResolvedValue([
      { wallet: mafia, flags: FLAG_ACTIVE }, { wallet: townA, flags: FLAG_ACTIVE },
    ]),
    rolesFor: vi.fn().mockReturnValue(new Map([[mafia.toLowerCase(), Role.MAFIA], [townA.toLowerCase(), Role.CITIZEN]])),
    isAgent: vi.fn().mockResolvedValue(true),
    getRoomSecrets: vi.fn().mockResolvedValue({}),
    generateProof: vi.fn().mockResolvedValue('["0x1","0x2"],[["0x3","0x4"],["0x5","0x6"]],["0x7","0x8"],["0x9","0xa","0xb","0xc","0xd","0xe"]'),
    sendEndGameZK: vi.fn().mockResolvedValue({ hash: "0xzk" }),
    revealRoles: vi.fn().mockResolvedValue({ hash: "0xrv" }),
    walletFor: vi.fn().mockReturnValue({ address: mafia }),
    ...over,
  };
}

describe("maybeFinalizeHeadlessWin — gating", () => {
  it("disabled when AGENTS_ENABLED!=true", async () => {
    const prev = process.env.AGENTS_ENABLED; process.env.AGENTS_ENABLED = "false";
    const r = await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, baseDeps() as any);
    process.env.AGENTS_ENABLED = prev;
    expect(r).toBe("disabled");
  });
  it("has-human when an alive player is not an agent", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({
      getPlayers: vi.fn().mockResolvedValue([{ wallet: mafia, flags: FLAG_ACTIVE }, { wallet: human, flags: FLAG_ACTIVE }]),
      isAgent: vi.fn().mockImplementation(async (_r: bigint, a: string) => a.toLowerCase() !== human.toLowerCase()),
    });
    const r = await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any);
    expect(r).toBe("has-human");
    expect(deps.sendEndGameZK).not.toHaveBeenCalled();
  });
  it("no-win when mafia < town", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({
      getPlayers: vi.fn().mockResolvedValue([{ wallet: mafia, flags: FLAG_ACTIVE }, { wallet: townA, flags: FLAG_ACTIVE }, { wallet: "0xT2", flags: FLAG_ACTIVE }]),
      rolesFor: vi.fn().mockReturnValue(new Map([[mafia.toLowerCase(), Role.MAFIA], [townA.toLowerCase(), Role.CITIZEN], ["0xt2", Role.CITIZEN]])),
    });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("no-win");
  });
  it("no-win when mafia wins but townCount===0 (endGameZK would revert)", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({
      getPlayers: vi.fn().mockResolvedValue([{ wallet: mafia, flags: FLAG_ACTIVE }, { wallet: "0xM2", flags: FLAG_ACTIVE }]),
      rolesFor: vi.fn().mockReturnValue(new Map([[mafia.toLowerCase(), Role.MAFIA], ["0xm2", Role.MAFIA]])),
    });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("no-win");
  });
  it("already-ended when room not in active phase (DAY/VOTING/NIGHT)", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({ getRoom: vi.fn().mockResolvedValue({ phase: 6 }) });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("already-ended");
  });
  it("already-ended when SETNX guard already held", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({ redis: { set: vi.fn().mockResolvedValue(null), del: vi.fn() } });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("already-ended");
  });
});

describe("maybeFinalizeHeadlessWin — finalize", () => {
  it("mafia win → endGameZK from a MAFIA agent EOA, then revealRoles", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({
      getRoomSecrets: vi.fn().mockResolvedValue({
        [mafia.toLowerCase()]: { role: 1, salt: "00", commitment: "1" },
        [townA.toLowerCase()]: { role: 0, salt: "01", commitment: "2" },
      }),
    });
    const r = await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any);
    expect(r).toBe("finalized");
    expect(deps.generateProof).toHaveBeenCalledTimes(1);
    expect(deps.walletFor).toHaveBeenCalledWith(50312, "9", mafia); // winning faction signer
    expect(deps.sendEndGameZK).toHaveBeenCalledTimes(1);
    expect(deps.revealRoles).toHaveBeenCalledTimes(1);
  });

  it("town win → endGameZK from a TOWN agent EOA", async () => {
    process.env.AGENTS_ENABLED = "true";
    const t2 = "0xT2";
    const deps = baseDeps({
      getPlayers: vi.fn().mockResolvedValue([{ wallet: townA, flags: 0x2 }, { wallet: t2, flags: 0x2 }]),
      rolesFor: vi.fn().mockReturnValue(new Map([[townA.toLowerCase(), Role.CITIZEN], [t2.toLowerCase(), Role.DOCTOR]])),
      getRoomSecrets: vi.fn().mockResolvedValue({
        [townA.toLowerCase()]: { role: 0, salt: "00", commitment: "2" },
        [t2.toLowerCase()]: { role: 0, salt: "01", commitment: "3" },
      }),
      walletFor: vi.fn().mockReturnValue({ address: townA }),
    });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("finalized");
    expect(deps.walletFor).toHaveBeenCalledWith(50312, "9", townA);
    expect(deps.revealRoles).toHaveBeenCalledTimes(1);
  });

  it("missing secret for a player → endGameZK still sent, reveal skipped", async () => {
    process.env.AGENTS_ENABLED = "true";
    const deps = baseDeps({
      getRoomSecrets: vi.fn().mockResolvedValue({ [mafia.toLowerCase()]: { role: 1, salt: "00", commitment: "1" } }), // townA missing
    });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("finalized");
    expect(deps.sendEndGameZK).toHaveBeenCalledTimes(1);
    expect(deps.revealRoles).not.toHaveBeenCalled();
  });

  it("endGameZK revert → releases guard, returns error, no reveal", async () => {
    process.env.AGENTS_ENABLED = "true";
    const del = vi.fn();
    const deps = baseDeps({
      redis: { set: vi.fn().mockResolvedValue("OK"), del },
      getRoomSecrets: vi.fn().mockResolvedValue({
        [mafia.toLowerCase()]: { role: 1, salt: "00", commitment: "1" },
        [townA.toLowerCase()]: { role: 0, salt: "01", commitment: "2" },
      }),
      sendEndGameZK: vi.fn().mockRejectedValue(new Error("execution reverted: No town players")),
    });
    expect(await maybeFinalizeHeadlessWin({ chainId: 50312, roomId: "9" }, deps as any)).toBe("error");
    expect(del).toHaveBeenCalledWith("agents:endgame:50312:9");
    expect(deps.revealRoles).not.toHaveBeenCalled();
  });
});

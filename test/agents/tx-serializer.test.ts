import { describe, it, expect, vi, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Chain } from "viem";
import {
  runExclusive,
  pickNonce,
  serializedWalletClient,
} from "../../src/agents/tx-serializer.js";

const FAKE_CHAIN = {
  id: 5031,
  name: "test",
  nativeCurrency: { name: "SOMI", symbol: "SOMI", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:1"] } },
} as unknown as Chain;

// Unique account per test so the module-level localNonce/lastBroadcastAt maps
// don't leak state between cases.
let keySeed = 1;
const freshAccount = () =>
  privateKeyToAccount(("0x" + String(keySeed++).padStart(64, "0")) as `0x${string}`);

const slow = (events: string[], id: string, ms: number) => async () => {
  events.push(`${id}:start`);
  await new Promise((r) => setTimeout(r, ms));
  events.push(`${id}:end`);
  return id;
};

describe("runExclusive", () => {
  it("serializes calls for the same key — second waits for the first to finish", async () => {
    const ev: string[] = [];
    const p1 = runExclusive("0xWALLET", slow(ev, "1", 30));
    const p2 = runExclusive("0xWALLET", slow(ev, "2", 5));
    await Promise.all([p1, p2]);
    expect(ev).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });

  it("runs different keys concurrently", async () => {
    const ev: string[] = [];
    await Promise.all([
      runExclusive("0xA", slow(ev, "A", 20)),
      runExclusive("0xB", slow(ev, "B", 20)),
    ]);
    // both started before either ended
    expect(ev.slice(0, 2).sort()).toEqual(["A:start", "B:start"]);
  });

  it("a rejection does not block the next call on the same key", async () => {
    await expect(
      runExclusive("0xA", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(runExclusive("0xA", async () => "ok")).resolves.toBe("ok");
  });

  it("treats the key case-insensitively (same wallet, mixed case)", async () => {
    const ev: string[] = [];
    await Promise.all([
      runExclusive("0xAbCd", slow(ev, "1", 25)),
      runExclusive("0xabcd", slow(ev, "2", 5)),
    ]);
    expect(ev).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });
});

describe("pickNonce", () => {
  const LAG = 3000;

  it("within the lag window keeps the local high-water so a burst doesn't collide", () => {
    // Somnia's pending count lags a just-broadcast tx: chain still says 111 but
    // we already reserved 111 locally → the next burst tx must take 112, not 111.
    expect(pickNonce(111, 112, 50, LAG)).toBe(112);
  });

  it("heals a stuck-high local nonce after a dropped tx (the room-66 freeze)", () => {
    // A prior tx was broadcast (local advanced to 117) then silently evicted by
    // the node, so chain's next-expected is still 111. Outside the lag window
    // the local value is stale → must fall back to chain so the gap heals.
    expect(pickNonce(111, 117, 5000, LAG)).toBe(111);
  });

  it("always respects external upward drift (never reuses a live nonce)", () => {
    expect(pickNonce(120, 111, 50, LAG)).toBe(120); // recent branch
    expect(pickNonce(120, 111, 5000, LAG)).toBe(120); // stale branch
  });
});

describe("serializedWalletClient — nonce recovery (room-66 end-to-end)", () => {
  afterEach(() => vi.useRealTimers());

  it("falls back to chain after a silently-dropped tx instead of climbing forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const account = freshAccount();
    let chainPending = 111; // node's next-expected; every tx below is dropped, so it never advances
    const sent: number[] = [];

    const wallet = serializedWalletClient(account, FAKE_CHAIN, "http://localhost:1", {
      getPendingNonce: async () => chainPending,
      rawWrite: async (args) => {
        sent.push(args.nonce as number);
        return ("0x" + "f".repeat(64)) as `0x${string}`; // "accepted" — then silently evicted
      },
    });

    // 1st GM resolve: cold → chain nonce 111. Node accepts then drops it (chainPending stays 111).
    await (wallet.writeContract as any)({});
    // 2nd, in the same instant (within the lag window): local high-water guards the burst → 112.
    await (wallet.writeContract as any)({});
    // GM retries ~130s later (well past the 3s lag window).
    vi.setSystemTime(130_000);
    await (wallet.writeContract as any)({});

    // The retry must REUSE the freed chain nonce 111, not climb to 113 (the freeze).
    expect(sent).toEqual([111, 112, 111]);
  });
});

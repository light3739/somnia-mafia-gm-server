import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  loadLedger,
  appendVote,
  appendKill,
  appendDeath,
} from "../../src/agents/ledger.js";

class FakeRedis {
  private store = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.store.get(k) ?? null; }
  async set(k: string, v: string, ..._args: any[]): Promise<"OK"> { this.store.set(k, v); return "OK"; }
}

const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";

describe("ledger", () => {
  it("loadLedger returns empty shape on miss", async () => {
    const r = new FakeRedis() as any;
    const led = await loadLedger(r, 50312, "8");
    expect(led).toEqual({
      votes: [], kills: [], deaths: [],
      accusations: [], claims: [], defenses: [],
    });
  });

  it("appendVote roundtrips via Redis", async () => {
    const r = new FakeRedis() as any;
    await appendVote(r, 50312, "8", { day: 1, from: A, to: B, txHash: "0xdeadbeef", logIndex: 3 });
    const led = await loadLedger(r, 50312, "8");
    expect(led.votes).toHaveLength(1);
    expect(led.votes[0].from).toEqual(A);
    expect(led.votes[0].to).toEqual(B);
  });

  it("appendKill / appendDeath roundtrip", async () => {
    const r = new FakeRedis() as any;
    await appendKill(r, 50312, "8", { day: 1, victim: A });
    await appendDeath(r, 50312, "8", { day: 1, player: A, cause: "night-kill" });
    const led = await loadLedger(r, 50312, "8");
    expect(led.kills).toEqual([{ day: 1, victim: A }]);
    expect(led.deaths).toEqual([{ day: 1, player: A, cause: "night-kill" }]);
  });

  it("reserved chat-derived arrays remain empty in v1", async () => {
    const r = new FakeRedis() as any;
    await appendVote(r, 50312, "8", { day: 1, from: A, to: B, txHash: "0x", logIndex: 0 });
    const led = await loadLedger(r, 50312, "8");
    expect(led.accusations).toEqual([]);
    expect(led.claims).toEqual([]);
    expect(led.defenses).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  loadSuspicion,
  applyVoteEvent,
  applyKillEvent,
} from "../../src/agents/suspicion.js";

class FakeRedis {
  private kv = new Map<string, string>();
  private setKv = new Map<string, Set<string>>();
  async get(k: string): Promise<string | null> { return this.kv.get(k) ?? null; }
  async set(k: string, v: string, ..._args: any[]): Promise<"OK"> { this.kv.set(k, v); return "OK"; }
  async sismember(k: string, m: string): Promise<number> {
    const s = this.setKv.get(k); return s && s.has(m) ? 1 : 0;
  }
  async sadd(k: string, m: string): Promise<number> {
    let s = this.setKv.get(k); if (!s) { s = new Set(); this.setKv.set(k, s); }
    if (s.has(m)) return 0; s.add(m); return 1;
  }
  async expire(_k: string, _s: number): Promise<number> { return 1; }
}

const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";
const C: Address = "0x000000000000000000000000000000000000000c";

describe("suspicion v1 (chain-only)", () => {
  it("loadSuspicion empty default", async () => {
    const r = new FakeRedis() as any;
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.suspicion).toEqual({});
    expect(s.trust).toEqual({});
    expect(s.notes).toEqual([]);
  });

  it("applyVoteEvent voter->self gives strong +0.15", async () => {
    const r = new FakeRedis() as any;
    await applyVoteEvent(r, 50312, "8", A, {
      eventId: "vote-0xaaa-1", day: 1, from: B, to: A,
    });
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.suspicion[B.toLowerCase()]).toBeCloseTo(0.15);
  });

  it("applyVoteEvent voter->other gives mild +0.02 from A's perspective", async () => {
    const r = new FakeRedis() as any;
    await applyVoteEvent(r, 50312, "8", A, {
      eventId: "vote-0xaaa-1", day: 1, from: B, to: C,
    });
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.suspicion[B.toLowerCase()]).toBeCloseTo(0.02);
  });

  it("idempotent on same eventId — no double-apply", async () => {
    const r = new FakeRedis() as any;
    const ev = { eventId: "vote-0xaaa-1", day: 1, from: B, to: A };
    await applyVoteEvent(r, 50312, "8", A, ev);
    await applyVoteEvent(r, 50312, "8", A, ev);
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.suspicion[B.toLowerCase()]).toBeCloseTo(0.15);
  });

  it("KILL does NOT mutate the suspicion vector in v1", async () => {
    const r = new FakeRedis() as any;
    await applyKillEvent(r, 50312, "8", A, {
      eventId: "night-50312-8-1", day: 1, victim: C,
    });
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.suspicion).toEqual({});
    expect(s.notes.some(n => n.includes("night kill"))).toEqual(true);
  });

  it("caps suspicion at 1.0", async () => {
    const r = new FakeRedis() as any;
    for (let i = 0; i < 20; i++) {
      await applyVoteEvent(r, 50312, "8", A, {
        eventId: `vote-${i}`, day: 1, from: B, to: A,
      });
    }
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.suspicion[B.toLowerCase()]).toBeLessThanOrEqual(1.0);
  });

  it("notes truncate to last 20", async () => {
    const r = new FakeRedis() as any;
    for (let i = 0; i < 30; i++) {
      await applyVoteEvent(r, 50312, "8", A, {
        eventId: `vote-${i}`, day: 1, from: B, to: A,
      });
    }
    const s = await loadSuspicion(r, 50312, "8", A);
    expect(s.notes.length).toBeLessThanOrEqual(20);
  });
});

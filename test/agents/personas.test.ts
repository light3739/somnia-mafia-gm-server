import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { PERSONA_POOL, pickPersonaByEoa, getOrPinPersona } from "../../src/agents/personas.js";
import { agentPersonaKey } from "../../src/agents/redis-keys.js";

class FakeRedis {
  private store = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  async set(k: string, v: string, ..._args: any[]): Promise<"OK"> {
    this.store.set(k, v);
    return "OK";
  }
}

function fixedAddr(i: number): Address {
  return ("0x" + i.toString(16).padStart(40, "0")) as Address;
}

describe("pickPersonaByEoa", () => {
  it("pool has exactly 10 entries", () => {
    expect(PERSONA_POOL.length).toEqual(10);
  });

  it("is deterministic for the same address", () => {
    const a = pickPersonaByEoa(fixedAddr(1));
    const b = pickPersonaByEoa(fixedAddr(1));
    expect(a).toEqual(b);
  });

  it("all 10 personas are reachable within 1000 sampled addresses", () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 1000; i++) {
      seen.add(pickPersonaByEoa(fixedAddr(i)));
    }
    expect(seen.size).toEqual(10);
  });

  it("distribution is roughly even (50-150 per persona over 1000 samples)", () => {
    const counts = new Map<string, number>();
    for (let i = 1; i <= 1000; i++) {
      const p = pickPersonaByEoa(fixedAddr(i));
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const c of counts.values()) {
      expect(c).toBeGreaterThanOrEqual(50);
      expect(c).toBeLessThanOrEqual(150);
    }
  });
});

describe("getOrPinPersona", () => {
  it("returns the stored persona if Redis has one", async () => {
    const redis = new FakeRedis() as any;
    await redis.set(agentPersonaKey(50312, "8", fixedAddr(1)), "calm logical analyst");
    const p = await getOrPinPersona(redis, 50312, "8", fixedAddr(1));
    expect(p).toEqual("calm logical analyst");
  });

  it("recomputes + pins the persona on miss", async () => {
    const redis = new FakeRedis() as any;
    const addr = fixedAddr(7);
    const p = await getOrPinPersona(redis, 50312, "8", addr);
    expect(PERSONA_POOL).toContain(p);
    const stored = await redis.get(agentPersonaKey(50312, "8", addr));
    expect(stored).toEqual(p);
  });
});

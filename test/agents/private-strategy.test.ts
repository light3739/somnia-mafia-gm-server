import { describe, it, expect } from "vitest";
import { loadRoomRoles, buildPrivateStrategyLines } from "../../src/agents/private-strategy.js";
import { AgentRole } from "../../src/agents/roles.js";
import type { Address } from "viem";

class FakeRedis {
  store = new Map<string, string>();
  async keys(pattern: string) {
    const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return [...this.store.keys()].filter((k) => re.test(k));
  }
  async mget(keys: string[]) { return keys.map((k) => this.store.get(k) ?? null); }
}

const CHAIN = 50312, ROOM = "7";
const SELF = "0xaaaa000000000000000000000000000000000001" as Address;
const MATE = "0xbbbb000000000000000000000000000000000002" as Address;
const T1 = "0xcccc000000000000000000000000000000000003" as Address;
const T2 = "0xdddd000000000000000000000000000000000004" as Address;
const nameOf = (a: string) => ({ [MATE.toLowerCase()]: "Alice" } as Record<string, string>)[a.toLowerCase()] ?? a.slice(0, 6);

describe("loadRoomRoles", () => {
  it("reads the agents:role keyspace", async () => {
    const r = new FakeRedis();
    r.store.set(`agents:role:${CHAIN}:${ROOM}:${SELF.toLowerCase()}`, "1");
    r.store.set(`agents:role:${CHAIN}:${ROOM}:${MATE.toLowerCase()}`, "1");
    r.store.set(`agents:role:${CHAIN}:${ROOM}:${T1.toLowerCase()}`, "4");
    const roles = await loadRoomRoles(r as any, CHAIN, ROOM);
    expect(roles.get(SELF.toLowerCase())).toBe(AgentRole.MAFIA);
    expect(roles.get(T1.toLowerCase())).toBe(AgentRole.CITIZEN);
  });
});

describe("buildPrivateStrategyLines", () => {
  const roles = new Map<string, AgentRole>([
    [SELF.toLowerCase(), AgentRole.MAFIA],
    [MATE.toLowerCase(), AgentRole.MAFIA],
    [T1.toLowerCase(), AgentRole.CITIZEN],
    [T2.toLowerCase(), AgentRole.DOCTOR],
  ]);

  it("mafia: exact counts + teammate names + secrecy guard", () => {
    const lines = buildPrivateStrategyLines({ role: AgentRole.MAFIA, roles, alive: [SELF, MATE, T1, T2], self: SELF, nameOf });
    const joined = lines.join("\n");
    expect(joined).toContain("you + Alice");
    expect(joined).toContain("Mafia alive: 2, Town alive: 2");
    expect(joined).toContain("Town deaths still needed to win: 0");
    expect(joined).toContain("Never hint that you know");
  });

  it("mafia night adds the no-self-kill line", () => {
    const lines = buildPrivateStrategyLines({ role: AgentRole.MAFIA, roles, alive: [SELF, MATE, T1, T2], self: SELF, nameOf, forNight: true });
    expect(lines.join("\n")).toContain("Never target your own team");
  });

  it("town roles get no lines", () => {
    expect(buildPrivateStrategyLines({ role: AgentRole.DOCTOR, roles, alive: [SELF, T1], self: T1, nameOf })).toEqual([]);
  });
});

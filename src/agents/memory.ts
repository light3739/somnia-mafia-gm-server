/**
 * agents/memory.ts - minimal factual memory for private agent knowledge.
 *
 * v1 stores only verified GM facts. It is intentionally not a social memory or
 * chat summarizer; those are higher-risk and can be layered later.
 */
import type { Redis } from "ioredis";
import type { Address } from "viem";
import { agentMemoryKey, IDEMPOTENCY_TTL_SECONDS } from "./redis-keys.js";
import { AgentRole, roleLabel } from "./roles.js";

export type InvestigationFact = {
  id: string;
  type: "investigation";
  day: number;
  target: Address;
  role: AgentRole;
  roleLabel: string;
  source: "gm-night-action";
  ts: number;
};

export type AgentMemoryFact = InvestigationFact;

export type AgentMemory = {
  version: 1;
  facts: AgentMemoryFact[];
  updatedAt: number;
};

function emptyMemory(): AgentMemory {
  return { version: 1, facts: [], updatedAt: Date.now() };
}

export async function loadAgentMemory(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Address
): Promise<AgentMemory> {
  const raw = await redis.get(agentMemoryKey(chainId, roomId, agent));
  if (!raw) return emptyMemory();
  try {
    const parsed = JSON.parse(raw) as Partial<AgentMemory>;
    return {
      version: 1,
      facts: Array.isArray(parsed.facts) ? parsed.facts as AgentMemoryFact[] : [],
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return emptyMemory();
  }
}

export async function appendAgentMemoryFact(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Address,
  fact: AgentMemoryFact
): Promise<AgentMemory> {
  const memory = await loadAgentMemory(redis, chainId, roomId, agent);
  if (!memory.facts.some((f) => f.id === fact.id)) {
    memory.facts.push(fact);
  }
  memory.facts = memory.facts.slice(-50);
  memory.updatedAt = Date.now();
  await redis.set(
    agentMemoryKey(chainId, roomId, agent),
    JSON.stringify(memory),
    "EX",
    IDEMPOTENCY_TTL_SECONDS
  );
  return memory;
}

export function makeInvestigationFact(args: {
  day: number;
  detective: Address;
  target: Address;
  role: AgentRole;
  ts?: number;
}): InvestigationFact {
  return {
    id: `investigation:${args.day}:${args.detective.toLowerCase()}:${args.target.toLowerCase()}`,
    type: "investigation",
    day: args.day,
    target: args.target,
    role: args.role,
    roleLabel: roleLabel(args.role),
    source: "gm-night-action",
    ts: args.ts ?? Date.now(),
  };
}

export function memoryPromptLines(memory: AgentMemory): string[] {
  return memory.facts.slice(-12).map((fact) => {
    switch (fact.type) {
      case "investigation":
        return `Night ${fact.day}: private investigation result for ${fact.target.toLowerCase()} is ${fact.roleLabel}.`;
    }
  });
}

export async function loadMemoryPromptLines(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Address
): Promise<string[]> {
  return memoryPromptLines(await loadAgentMemory(redis, chainId, roomId, agent));
}

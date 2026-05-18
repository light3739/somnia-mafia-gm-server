/**
 * agents/roles.ts — Per-agent role lookup/persist.
 *
 * Mafia roles are NEVER stored on-chain (privacy by design — see
 * NightFacet.sol comment header). The off-chain GM assigns each agent a role
 * during game setup and writes it to Redis; phase handlers (4f NIGHT,
 * 4d DAY chat) read it back to gate tool exposure / prompt persona.
 *
 * The Redis key is owned by `agentRoleKey()` in redis-keys.ts. Value is the
 * MafiaTypes.Role enum int as a string ("1"=MAFIA, "2"=DOCTOR, "3"=DETECTIVE,
 * "4"=CITIZEN). `0`/missing means "no role assigned" — handler should skip.
 */
import type { Redis } from "ioredis";
import type { Hex } from "viem";
import { agentRoleKey, IDEMPOTENCY_TTL_SECONDS } from "./redis-keys.js";

export enum AgentRole {
  NONE = 0,
  MAFIA = 1,
  DOCTOR = 2,
  DETECTIVE = 3,
  CITIZEN = 4,
}

export function parseRole(raw: string | null): AgentRole {
  if (!raw) return AgentRole.NONE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 4) return AgentRole.NONE;
  return n as AgentRole;
}

export async function getAgentRole(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Hex
): Promise<AgentRole> {
  const raw = await redis.get(agentRoleKey(chainId, roomId, agent));
  return parseRole(raw);
}

/**
 * Set the role for a single agent. Used by the GM during game setup.
 * Idempotent — overwrites any previous value. TTL matches idempotency markers
 * so stale roles from completed games eventually evict.
 */
export async function setAgentRole(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Hex,
  role: AgentRole
): Promise<void> {
  await redis.set(
    agentRoleKey(chainId, roomId, agent),
    String(role),
    "EX",
    IDEMPOTENCY_TTL_SECONDS
  );
}

export function roleLabel(role: AgentRole): string {
  switch (role) {
    case AgentRole.MAFIA:
      return "Mafia";
    case AgentRole.DOCTOR:
      return "Doctor";
    case AgentRole.DETECTIVE:
      return "Detective";
    case AgentRole.CITIZEN:
      return "Citizen";
    default:
      return "Unknown";
  }
}

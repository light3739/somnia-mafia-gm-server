/**
 * agents/role-sync.ts - bridge GM-resolved roles into the agent Redis keyspace.
 *
 * The GM server keeps authoritative roles under gm:room:* and in
 * store.resolvedRoles. Agent handlers intentionally read a narrower
 * agents:role:* key so they do not depend on route-local GM state. This module
 * keeps those two stores in sync after the GM resolves or restores roles.
 */
import type { Redis } from "ioredis";
import type { Address } from "viem";
import { Role } from "../types/contract.js";
import { AgentRole, setAgentRole } from "./roles.js";

export function toAgentRole(role: Role): AgentRole {
  switch (role) {
    case Role.MAFIA:
      return AgentRole.MAFIA;
    case Role.DOCTOR:
      return AgentRole.DOCTOR;
    case Role.DETECTIVE:
      return AgentRole.DETECTIVE;
    case Role.CITIZEN:
      return AgentRole.CITIZEN;
    default:
      return AgentRole.NONE;
  }
}

export async function syncAgentRolesFromResolvedRoles(
  redis: Redis,
  chainId: number,
  roomId: string,
  roles: Map<string, Role>
): Promise<void> {
  await Promise.all(
    [...roles.entries()].map(([addr, role]) =>
      setAgentRole(
        redis,
        chainId,
        roomId,
        addr.toLowerCase() as Address,
        toAgentRole(role)
      )
    )
  );
}

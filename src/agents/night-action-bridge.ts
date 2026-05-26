/**
 * agents/night-action-bridge.ts - feed autonomous NIGHT decisions into the
 * existing GM night-state pipeline.
 *
 * Agent night.ts commits an opaque inference trace on chain. This bridge records
 * the decoded action in the same in-process/Redis state used by POST
 * /night-action, so mixed human+agent rooms resolve through one code path.
 */
import type { Address, Hex } from "viem";
import type { GMStore } from "../stores/index.js";
import type { RedisClient } from "../redis.js";
import { rPersistNightState, rPersistProof } from "../redis.js";
import { getOrCreateNightState, getNightState } from "../game-state.js";
import { FLAGS, getPlayers } from "../chain.js";
import { Role } from "../types/contract.js";
import { logger } from "../utils/logger.js";
import { resolveNightWithFloor, ensureNightTimeout } from "../routes/nightRoutes.js";
import { appendAgentMemoryFact, makeInvestigationFact } from "./memory.js";
import { toAgentRole } from "./role-sync.js";

export type GmNightActionType = "kill" | "heal" | "check" | "skip";

export interface AgentNightActionRecord {
  chainId: number;
  roomId: string;
  dayCount: number;
  playerAddress: Address;
  actionType: GmNightActionType;
  targetAddress: Address;
  source?: string;
  commitTxHash?: Hex | null;
  timestamp?: number;
}

export interface AgentNightActionRecordResult {
  recorded: boolean;
  resolvedTriggered: boolean;
  memoryWritten: boolean;
  reason?: string;
}

interface PlayerLike {
  wallet: Address;
  flags: number | bigint;
}

function allRolePlayersActed(
  roles: Map<string, Role> | undefined,
  state: { actions: Map<string, unknown> },
  alivePlayers: readonly PlayerLike[]
): boolean {
  if (!roles) return false;

  const roleActors = alivePlayers.filter((p) => {
    const r = roles.get(p.wallet.toLowerCase());
    return r !== undefined && r !== Role.CITIZEN && r !== Role.NONE;
  });

  if (roleActors.length > 0) {
    return roleActors.every((p) => state.actions.has(p.wallet.toLowerCase()));
  }

  return alivePlayers.every((p) => state.actions.has(p.wallet.toLowerCase()));
}

export async function recordAgentNightAction(
  input: AgentNightActionRecord,
  deps: { store: GMStore; redis: RedisClient }
): Promise<AgentNightActionRecordResult> {
  const { store, redis } = deps;
  const rid = BigInt(input.roomId);
  const roomKey = store.getRoomKey(input.chainId, input.roomId);
  const lowerPlayer = input.playerAddress.toLowerCase();
  const roles = store.resolvedRoles.get(roomKey);
  const playerRole = roles?.get(lowerPlayer);
  const required: Partial<Record<GmNightActionType, Role>> = {
    kill: Role.MAFIA,
    heal: Role.DOCTOR,
    check: Role.DETECTIVE,
  };
  const requiredRole = required[input.actionType];

  if (requiredRole !== undefined && playerRole !== undefined && playerRole !== requiredRole) {
    logger.warn(
      {
        roomId: input.roomId,
        chainId: input.chainId,
        agent: lowerPlayer,
        actionType: input.actionType,
        playerRole,
        requiredRole,
      },
      "[agents/night-bridge] refusing role-mismatched agent night action"
    );
    return {
      recorded: false,
      resolvedTriggered: false,
      memoryWritten: false,
      reason: "role-mismatch",
    };
  }

  const hadState = !!getNightState(rid);
  const state = getOrCreateNightState(rid, input.chainId);
  if (state.resolved) {
    return {
      recorded: false,
      resolvedTriggered: false,
      memoryWritten: false,
      reason: "night-already-resolved",
    };
  }

  const ts = input.timestamp ?? Date.now();
  state.actions.set(lowerPlayer, {
    playerAddress: input.playerAddress,
    actionType: input.actionType,
    targetAddress: input.targetAddress,
    timestamp: ts,
  });

  if (redis) {
    rPersistNightState(redis, input.chainId, input.roomId, state);
  }

  let memoryWritten = false;
  if (input.actionType === "check") {
    store.getRoomMap(store.investigationProofs, roomKey).set(lowerPlayer, {
      targetAddress: input.targetAddress,
      timestamp: ts,
    });
    if (redis) {
      rPersistProof(redis, input.chainId, input.roomId, lowerPlayer, {
        targetAddress: input.targetAddress,
        timestamp: ts,
      });

      const targetRole = roles?.get(input.targetAddress.toLowerCase());
      if (targetRole !== undefined) {
        await appendAgentMemoryFact(
          redis,
          input.chainId,
          input.roomId,
          input.playerAddress,
          makeInvestigationFact({
            day: input.dayCount,
            detective: input.playerAddress,
            target: input.targetAddress,
            role: toAgentRole(targetRole),
            ts,
          })
        );
        memoryWritten = true;
      }
    }
  }

  let resolvedTriggered = false;
  try {
    const players = await getPlayers(rid, input.chainId) as readonly PlayerLike[];
    const alivePlayers = players.filter((p) => !!(Number(p.flags) & FLAGS.ACTIVE));
    if (allRolePlayersActed(roles, state, alivePlayers)) {
      resolvedTriggered = true;
      resolveNightWithFloor(rid, store, redis, input.chainId).catch((err) => {
        logger.error(
          { err, roomId: input.roomId, chainId: input.chainId },
          "[agents/night-bridge] auto-resolve failed"
        );
      });
    } else if (!hadState) {
      ensureNightTimeout(rid, store, redis, input.chainId);
    }
  } catch (err: any) {
    logger.warn(
      { err: String(err?.message ?? err), roomId: input.roomId, chainId: input.chainId },
      "[agents/night-bridge] players fetch failed; scheduling timeout fallback"
    );
    if (!hadState) {
      ensureNightTimeout(rid, store, redis, input.chainId);
    }
  }

  return { recorded: true, resolvedTriggered, memoryWritten };
}

import type { Address, Hex, HDAccount } from "viem";
import { computeWinner, type Winner } from "./win-detect.js";
import { Role } from "../types/contract.js";
import { logger } from "../utils/logger.js";

const FLAG_ACTIVE = 0x2;
export type FinalizeOutcome = "finalized" | "no-win" | "has-human" | "already-ended" | "disabled" | "error";

export interface HeadlessEndgameDeps {
  redis: { set: Function; del: Function };
  getRoom(roomId: bigint, chainId: number): Promise<{ phase: number }>;
  getPlayers(roomId: bigint, chainId: number): Promise<readonly { wallet: string; flags: number | bigint }[]>;
  rolesFor(chainId: number, roomId: string): Map<string, Role>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  getRoomSecrets(roomId: string, chainId: number): Promise<Record<string, { role: number; salt: string; commitment: string }> | null>;
  generateProof(roomId: string, zkInput: any[]): Promise<string>;
  sendEndGameZK(roomId: bigint, proof: any, agent: HDAccount, chainId: number): Promise<{ hash: Hex }>;
  revealRoles(roomId: bigint, chainId: number): Promise<{ hash: Hex }>;
  walletFor(chainId: number, roomId: string, agentAddr: Address): HDAccount;
}

export async function maybeFinalizeHeadlessWin(
  args: { chainId: number; roomId: string },
  deps: HeadlessEndgameDeps,
): Promise<FinalizeOutcome> {
  if ((process.env.AGENTS_ENABLED ?? "").toLowerCase() !== "true") return "disabled";
  const { chainId, roomId } = args;
  const rid = BigInt(roomId);

  const room = await deps.getRoom(rid, chainId);
  if (room.phase < 3 || room.phase > 5) return "already-ended";

  const players = await deps.getPlayers(rid, chainId);
  const alive = players.filter((p) => Number(p.flags) & FLAG_ACTIVE);
  if (alive.length === 0) return "no-win";

  const flags = await Promise.all(alive.map((p) => deps.isAgent(rid, p.wallet as Address)));
  if (!flags.every(Boolean)) return "has-human";

  const roles = deps.rolesFor(chainId, roomId);
  const { winner, townCount } = computeWinner(alive as unknown as Parameters<typeof computeWinner>[0], roles);
  if (!winner || townCount === 0) return "no-win"; // townCount===0 → endGameZK reverts "No town players"

  const guard = `agents:endgame:${chainId}:${roomId}`;
  const claimed = await deps.redis.set(guard, "1", "NX", "EX", 3600);
  if (claimed !== "OK") return "already-ended";

  try {
    return await runFinalize({ chainId, roomId, rid, alive, roles, winner }, deps);
  } catch (err: any) {
    logger.error({ err: err?.message ?? err, roomId }, "[headless-endgame] finalize failed");
    await deps.redis.del(guard);
    return "error";
  }
}

// Filled in Task 4. Stub for now so gating tests pass.
async function runFinalize(
  _ctx: { chainId: number; roomId: string; rid: bigint; alive: readonly { wallet: string; flags: number | bigint }[]; roles: Map<string, Role>; winner: Winner },
  _deps: HeadlessEndgameDeps,
): Promise<FinalizeOutcome> {
  return "finalized";
}

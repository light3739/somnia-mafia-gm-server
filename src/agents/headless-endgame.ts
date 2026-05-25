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

const ZERO_COMMIT = "14744269619966411208579211824598458697587494354926760081771325075741142829156";

async function runFinalize(
  ctx: { chainId: number; roomId: string; rid: bigint; alive: readonly { wallet: string; flags: number | bigint }[]; roles: Map<string, Role>; winner: Winner },
  deps: HeadlessEndgameDeps,
): Promise<FinalizeOutcome> {
  const { chainId, roomId, rid, alive, roles, winner } = ctx;
  const { parseGroth16CallData } = await import("./groth16.js");

  const players = await deps.getPlayers(rid, chainId);
  const secrets = (await deps.getRoomSecrets(roomId, chainId)) ?? {};

  // zkInput per /end-game-zk: dead players use zero-commitment so the on-chain hash matches.
  const zkInput = players.map((p) => {
    const addr = p.wallet.toLowerCase();
    const liveFlag = Number(p.flags) & FLAG_ACTIVE;
    const s = liveFlag ? secrets[addr] : undefined;
    return {
      role: s?.role === 1 ? 1 : 0,
      salt: s ? s.salt : "0".repeat(64),
      commitment: s ? s.commitment : ZERO_COMMIT,
      isActive: liveFlag ? 1 : 0,
    };
  });

  const callData = await deps.generateProof(roomId, zkInput);
  const proof = parseGroth16CallData(callData);

  // Sign endGameZK with an alive agent of the WINNING faction.
  const wantMafia = winner === "MAFIA";
  const signerAddr =
    alive.map((p) => p.wallet).find((w) => (roles.get(w.toLowerCase()) === Role.MAFIA) === wantMafia)
    ?? alive[0].wallet;
  const wallet = deps.walletFor(chainId, roomId, signerAddr as `0x${string}`);

  const { hash } = await deps.sendEndGameZK(rid, proof, wallet, chainId);
  logger.info({ roomId, chainId, winner, signer: signerAddr, hash }, "[headless-endgame] endGameZK sent by agent");

  // Reveal roles (GM). Needs every player's secret; skip+warn if any missing.
  const allHaveSecret = players.every((p) => secrets[p.wallet.toLowerCase()]);
  if (allHaveSecret) {
    const rv = await deps.revealRoles(rid, chainId);
    logger.info({ roomId, hash: rv.hash }, "[headless-endgame] roles revealed");
  } else {
    logger.warn({ roomId }, "[headless-endgame] secret missing — endGameZK done, reveal skipped");
  }
  return "finalized";
}

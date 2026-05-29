/**
 * agents/private-strategy.ts — role-conditional PRIVATE prompt lines.
 * Mafia get exact win-state math + a teammate roster (never broadcast; the
 * secrecy guard line keeps it out of public chat). Town roles get nothing here
 * (they rely on the public bound + their own factual memory).
 */
import type { Redis } from "ioredis";
import type { Address } from "viem";
import { AgentRole } from "./roles.js";
import { mafiaWinLines } from "./game-math.js";

type NameOf = (addr: string) => string;

/**
 * Scan room role keyspaces → Map<lowerAddr, AgentRole>. Mirrors the keyspaces
 * win-detect.resolveRolesWithFallback reads, but Redis-only (no GMStore):
 *   agents:role:{chain}:{room}:{addr}      (split idx 4)  — all-agent + agent rows
 *   gm:room:{chain}:{room}:role:{addr}     (split idx 5)  — human SRA-submitted rows
 * First writer wins per address.
 */
export async function loadRoomRoles(
  redis: Pick<Redis, "keys" | "mget">,
  chainId: number,
  roomId: string
): Promise<Map<string, AgentRole>> {
  const out = new Map<string, AgentRole>();
  const sources: { pattern: string; idx: number }[] = [
    { pattern: `agents:role:${chainId}:${roomId}:*`, idx: 4 },
    { pattern: `gm:room:${chainId}:${roomId}:role:*`, idx: 5 },
  ];
  for (const { pattern, idx } of sources) {
    const keys = await redis.keys(pattern);
    if (keys.length === 0) continue;
    const vals = await redis.mget(keys);
    for (let i = 0; i < keys.length; i++) {
      const addr = keys[i].split(":")[idx];
      const raw = vals[i];
      if (!addr || raw == null) continue;
      const role = Number(raw) as AgentRole;
      const lower = addr.toLowerCase();
      if (!out.has(lower)) out.set(lower, role);
    }
  }
  return out;
}

export function buildPrivateStrategyLines(args: {
  role: AgentRole;
  roles: Map<string, AgentRole>;
  alive: readonly Address[];
  self: Address;
  nameOf: NameOf;
  forNight?: boolean;
}): string[] {
  if (args.role !== AgentRole.MAFIA) return [];

  const selfLower = args.self.toLowerCase();
  const aliveLower = args.alive.map((a) => a.toLowerCase());

  const mafiaSet = new Set(aliveLower.filter((a) => args.roles.get(a) === AgentRole.MAFIA));
  mafiaSet.add(selfLower); // self is mafia even if its own role row is missing
  const mafiaAlive = aliveLower.filter((a) => mafiaSet.has(a)).length;
  const townAlive = Math.max(0, aliveLower.length - mafiaAlive);
  const teammateNames = aliveLower.filter((a) => a !== selfLower && mafiaSet.has(a)).map((a) => args.nameOf(a));

  const lines = mafiaWinLines({ mafiaAlive, townAlive, teammateNames });

  const unresolved = aliveLower.some((a) => a !== selfLower && !args.roles.has(a));
  if (unresolved && teammateNames.length === 0) {
    lines.push(`(A teammate's role is unconfirmed — at least 1 Mafia is alive; play it safe.)`);
  }

  lines.push(
    `Never hint that you know who the other Mafia are. In public, treat your teammates as ordinary players — do not coordinate openly, defend them suspiciously, or say "we".`
  );
  if (args.forNight) {
    lines.push(`Never target your own team. Prioritise anyone you can read as Doctor or Detective.`);
  }
  return lines;
}

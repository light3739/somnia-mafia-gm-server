/**
 * agents/personas.ts — Pool of 10 in-character personas + EOA-deterministic
 * picker + Redis pinning. See [[4d-day-chat-spec]].
 */
import type { Redis } from "ioredis";
import { keccak256, type Address, type Hex } from "viem";
import { agentPersonaKey, PERSONA_TTL_SECONDS } from "./redis-keys.js";
import { logger } from "../utils/logger.js";

export const PERSONA_POOL: readonly string[] = [
  "calm logical analyst",
  "loud sceptical accuser",
  "quiet observer",
  "nervous over-explainer",
  "dry sarcastic joker",
  "cautious pragmatic mediator",
  "paranoid suspicious sceptic",
  "bold confident leader voice",
  "soft empathic peacemaker",
  "blunt impatient pragmatist",
];

/** Deterministic: keccak(address) low 64 bits mod 10. */
export function pickPersonaByEoa(addr: Address | Hex): string {
  const h = keccak256(addr.toLowerCase() as Hex);
  const lo = BigInt(`0x${h.slice(-16)}`);
  const idx = Number(lo % BigInt(PERSONA_POOL.length));
  return PERSONA_POOL[idx];
}

export async function getOrPinPersona(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Address | Hex
): Promise<string> {
  const key = agentPersonaKey(chainId, roomId, agent);
  const stored = await redis.get(key);
  if (stored) return stored;
  const fresh = pickPersonaByEoa(agent);
  await redis.set(key, fresh, "EX", PERSONA_TTL_SECONDS);
  logger.warn(
    { agent, persona: fresh },
    "[agents/personas] persona missed in Redis, recomputed from EOA"
  );
  return fresh;
}

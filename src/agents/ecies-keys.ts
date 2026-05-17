/**
 * agents/ecies-keys.ts — P-256 keypair lifecycle for agents.
 *
 * The Mafia role-reveal flow encrypts each player's role to their P-256 public
 * key (see src/ecies.ts). Agents need a real keypair so the SHUFFLING/REVEAL
 * machinery treats them like any other player. We generate the keypair
 * server-side, post the *public* key to chain via joinRoom, and persist the
 * *private* key in Redis so 4f (NIGHT) and later phases can decrypt the agent's
 * role on demand without a wallet popup.
 *
 * Curve is `prime256v1` (P-256 / secp256r1) — matches services/eciesService.ts
 * on the frontend and src/ecies.ts on this server. Note this is a DIFFERENT
 * curve from the EVM signing key (secp256k1); we cannot reuse the EOA private
 * key as the ECIES key.
 *
 * Persistence: Redis only. If Redis is cold-restarted, agent keys are lost —
 * an in-flight game would be unrecoverable. Mid-hackathon this is acceptable;
 * post-hackathon, persist to disk-backed store.
 */
import { createECDH } from "node:crypto";
import type { Redis } from "ioredis";
import type { Address } from "viem";
import { logger } from "../utils/logger.js";

const NS = "agents:ecies";

/** TTL — long enough for a single multi-day game (1 month). */
const ECIES_TTL_SECONDS = 30 * 24 * 60 * 60;

function key(chainId: number, roomId: string, agent: Address): string {
  return `${NS}:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

export interface AgentEciesKeypair {
  /** 65-byte uncompressed P-256 point, hex without 0x prefix. */
  pubHex: string;
  /** 32-byte P-256 private scalar, hex without 0x prefix. */
  privHex: string;
}

/**
 * Idempotent: returns the existing keypair if one is already persisted for
 * (chainId, roomId, agent); otherwise generates + persists a fresh one.
 *
 * Generation is local (node:crypto, no network) so this is fast enough to
 * call inline during the fill-room flow.
 */
export async function ensureAgentEciesKeypair(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Address
): Promise<AgentEciesKeypair> {
  const k = key(chainId, roomId, agent);
  const existing = await redis.get(k);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as AgentEciesKeypair;
      if (parsed.pubHex && parsed.privHex) return parsed;
    } catch {
      logger.warn(
        { key: k },
        "[agents/ecies] corrupted entry — regenerating"
      );
    }
  }

  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pubHex = ecdh.getPublicKey("hex", "uncompressed"); // 65 bytes
  const privHex = ecdh.getPrivateKey("hex");

  const kp: AgentEciesKeypair = { pubHex, privHex };
  await redis.set(k, JSON.stringify(kp), "EX", ECIES_TTL_SECONDS);
  return kp;
}

/**
 * Lookup-only — null if the keypair was never created or has been evicted.
 * Used by future decryption flows (4f NIGHT, role-aware tools).
 */
export async function loadAgentEciesKeypair(
  redis: Redis,
  chainId: number,
  roomId: string,
  agent: Address
): Promise<AgentEciesKeypair | null> {
  const v = await redis.get(key(chainId, roomId, agent));
  if (!v) return null;
  try {
    return JSON.parse(v) as AgentEciesKeypair;
  } catch {
    return null;
  }
}

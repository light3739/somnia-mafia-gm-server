/**
 * agents/wallets.ts — HD-derived agent EOAs per (roomId, idx).
 *
 * Stateless by design: same (mnemonic, roomId, idx) tuple always yields the
 * same wallet, so a gm-server restart mid-game recovers the exact same agent
 * addresses without persistence. The orchestrator therefore needs only the
 * mnemonic in env (`AGENT_MASTER_MNEMONIC`) — no DB, no key store.
 *
 * Derivation path:  m/44'/60'/0'/{roomBucket}/{idx}
 *   - roomBucket = roomId & 0x7fffffff (BIP-32 indices are uint31; high bit
 *     masked off so the path stays valid). Cosmetic collision risk only —
 *     different rooms with the same low 31 bits would share addresses, but
 *     roomIds are small monotonic integers so this never happens in practice.
 *   - idx = 0..N-1 for N agents in the room.
 *
 * Ported from SomniaMafia/e2e-bots/agent-wallets.ts; gm-server-flavoured by
 * routing the missing-mnemonic warning through the shared logger.
 */
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import type { HDAccount } from "viem";
import { logger } from "../utils/logger.js";

function roomBucket(roomId: bigint | number): number {
  return Number(BigInt(roomId) & 0x7fffffffn);
}

export interface AgentWalletConfig {
  mnemonic: string;
  roomId: bigint | number;
  idx: number;
}

export interface AgentWallet {
  account: HDAccount;
  address: `0x${string}`;
  /** Derivation path. Useful for logs / audit. */
  path: string;
  idx: number;
}

export function deriveAgentWallet(cfg: AgentWalletConfig): AgentWallet {
  const bucket = roomBucket(cfg.roomId);
  const path = `m/44'/60'/0'/${bucket}/${cfg.idx}`;
  const account = mnemonicToAccount(cfg.mnemonic, {
    accountIndex: 0,
    changeIndex: bucket,
    addressIndex: cfg.idx,
  });
  return { account, address: account.address, path, idx: cfg.idx };
}

export function deriveAgentWallets(
  mnemonic: string,
  roomId: bigint | number,
  count: number
): AgentWallet[] {
  return Array.from({ length: count }, (_, idx) =>
    deriveAgentWallet({ mnemonic, roomId, idx })
  );
}

/**
 * Read AGENT_MASTER_MNEMONIC from env, or generate a fresh one for dev convenience.
 *
 * Production setups MUST pin the mnemonic in env — a generated one is
 * non-deterministic across restarts and orphans every agent in flight.
 */
export function loadOrGenerateMnemonic(envVar = "AGENT_MASTER_MNEMONIC"): string {
  const existing = process.env[envVar];
  if (existing && existing.trim().split(/\s+/).length >= 12) return existing.trim();
  const fresh = generateMnemonic(english);
  logger.warn(
    { envVar },
    `[agents] No ${envVar} in env — generated ephemeral mnemonic. Set it in .env to keep agent addresses stable across restarts.`
  );
  return fresh;
}

/**
 * How many HD slots a driver must derive to be able to match every agent a
 * room could hold. Agents are registered at idx = playersCount-at-fill + i
 * (see fill-room.ts), so the highest idx is offset by the humans already in
 * the room — a fixed `6` window orphans any agent past idx 5 (e.g. the 6th
 * agent in a room with a human → idx 6, never matched, never driven).
 *
 * Mirrors the wider window sweep.ts already uses. `+3` slack covers a player
 * leaving (current count < the max idx ever assigned); `12` floor keeps small
 * rooms generous. Cost is negligible — extra candidates are derived
 * deterministically and dropped if their address isn't on-chain.
 */
export function agentDeriveCount(playerCount: number): number {
  return Math.max(12, playerCount + 3);
}

/**
 * For an on-chain agent set, find the (idx, account) tuple that matches each
 * address. Caller supplies the candidate range (0..maxAgents-1). Size it with
 * `agentDeriveCount(playersCount)` — a fixed small window orphans offset
 * indices. Unmatched addresses are dropped (not our agents).
 */
export function matchWalletsToAgents(
  mnemonic: string,
  roomId: bigint | number,
  agentAddresses: readonly `0x${string}`[],
  maxAgents: number
): AgentWallet[] {
  const candidates = deriveAgentWallets(mnemonic, roomId, maxAgents);
  const byAddr = new Map(
    candidates.map((w) => [w.address.toLowerCase(), w] as const)
  );
  const matched: AgentWallet[] = [];
  for (const addr of agentAddresses) {
    const w = byAddr.get(addr.toLowerCase());
    if (w) matched.push(w);
  }
  return matched;
}

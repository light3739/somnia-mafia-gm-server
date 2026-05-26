/**
 * agents/redis-keys.ts — Centralised Redis key schema for the agent subsystem.
 *
 * Two distinct idempotency surfaces:
 *
 *   1. Event-level   — one Diamond log can be re-delivered after a WS reconnect
 *                      or backfill replay. Keyed by (chainId, txHash, logIndex).
 *                      Owned by 4a.
 *
 *   2. Action-level  — one agent must not be invoked twice for the same phase
 *                      slot (otherwise: two vote tx, two night actions). Keyed
 *                      by (chainId, roomId, phaseId, agent, actionType). Owned
 *                      by 4b onward.
 *
 * Also exposes a per-chain "last processed block" cursor so the listener can
 * backfill events missed during downtime.
 */
import type { Hex } from "viem";

const NS = "agents";

export function eventProcessedKey(
  chainId: number,
  txHash: Hex,
  logIndex: number
): string {
  return `${NS}:event:${chainId}:${txHash.toLowerCase()}:${logIndex}`;
}

export function agentActionProcessedKey(
  chainId: number,
  roomId: string,
  phaseId: string,
  agent: Hex,
  actionType: string
): string {
  return `${NS}:action:${chainId}:${roomId}:${phaseId}:${agent.toLowerCase()}:${actionType}`;
}

/** Room-level mutex for operator-triggered lobby fills. */
export function agentFillRoomLockKey(chainId: number, roomId: string): string {
  return `${NS}:filllock:${chainId}:${roomId}`;
}

export function lastBlockKey(chainId: number, diamond: Hex): string {
  return `${NS}:lastBlock:${chainId}:${diamond.toLowerCase()}`;
}

/**
 * Private trace store — full inference material kept off-chain until the room
 * reaches phase ENDED, then revealed via revealAgentInferenceTrace.
 *
 * Stored as a JSON blob with {salt, somniaRequestId, promptHash, responseHash,
 * actionHash, prompt, response, target, llmTxHash, voteTxHash, commitTxHash}.
 * The `Hash` fields are duplicated for redundancy — agent's reveal payload
 * only needs the hashes, but the full prompt/response are kept so the
 * post-game audit endpoint can replay the decision verbatim.
 */
export function agentTraceKey(
  chainId: number,
  roomId: string,
  phaseId: string,
  agent: Hex
): string {
  return `${NS}:trace:${chainId}:${roomId}:${phaseId}:${agent.toLowerCase()}`;
}

/**
 * Per-agent role assignment for a single room. Stored by the GM when it
 * assigns roles for the game; consumed by 4f NIGHT (role-gated tools list)
 * and later by 4d DAY chat (role-aware persona).
 *
 * Value is the MafiaTypes.Role enum int as a string: "1"=MAFIA, "2"=DOCTOR,
 * "3"=DETECTIVE, "4"=CITIZEN. Stored as string for ergonomic atomic SET.
 */
export function agentRoleKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:role:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/** TTL for idempotency markers — long enough to outlive any reasonable game
 * but short enough that Redis doesn't accumulate forever. 7 days. */
export const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 4d DAY chat — sliding window of last 20 sanitized chat msgs, fed into prompt. */
export function agentChatPromptKey(chainId: number, roomId: string): string {
  return `${NS}:chat:prompt:${chainId}:${roomId}`;
}

/** 4d DAY chat — append-only full chat log for audit / replay UI. */
export function agentChatLogKey(chainId: number, roomId: string): string {
  return `${NS}:chat:log:${chainId}:${roomId}`;
}

/** 4d DAY chat — JSON-encoded ledger {votes, kills, deaths, accusations, claims, defenses}.
 *  v1 only populates the chain-derived fields (votes, kills, deaths). */
export function agentLedgerKey(chainId: number, roomId: string): string {
  return `${NS}:ledger:${chainId}:${roomId}`;
}

/** 4d DAY chat — per-agent suspicion/trust vector + notes (JSON). */
export function agentSuspicionKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:suspicion:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/** 4d DAY chat — SET of processed suspicion-event ids (idempotency). */
export function agentSuspicionProcessedKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:suspicion:processed:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/** 4d DAY chat — persona string per agent, pinned at fill-room time (EX=7d). */
export function agentPersonaKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:persona:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/** 4d DAY chat — observability: why was this agent skipped for this phase? */
export function agentSkipReasonKey(
  chainId: number,
  roomId: string,
  phaseId: string,
  agent: Hex
): string {
  return `${NS}:skip:${chainId}:${roomId}:${phaseId}:${agent.toLowerCase()}`;
}

/** 4d DAY chat — local cache flag "we committed for this slot" — fast-path
 *  retry guard. On-chain getAgentMessageHash is source of truth. */
export function agentMessageCommittedKey(
  chainId: number,
  roomId: string,
  phaseId: string,
  agent: Hex
): string {
  return `${NS}:msg:committed:${chainId}:${roomId}:${phaseId}:${agent.toLowerCase()}`;
}

/** Two-way DAY chat — per-turn lock so many human pollers trigger an agent's
 *  turn exactly once. SET NX EX ~30s; TTL prevents a crash freezing the turn. */
export function agentTurnLockKey(
  chainId: number,
  roomId: string,
  dayCount: number,
  speakerIndex: number
): string {
  return `${NS}:turnlock:${chainId}:${roomId}:${dayCount}:${speakerIndex}`;
}

/** Once-per-(chain,room,day) claim so the headless-day driver runs a given DAY
 *  exactly once even if DAY_STARTED is re-delivered. */
export function agentHeadlessDayKey(
  chainId: number,
  roomId: string,
  dayCount: number
): string {
  return `${NS}:headlessday:${chainId}:${roomId}:${dayCount}`;
}

/** Minimal factual memory for private agent facts (detective result, later audits). */
export function agentMemoryKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:memory:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/**
 * 4j pre-game — per-agent SRA (commutative) keypair for the room's deck shuffle.
 * Value is JSON `{ e, d }` (encryption/decryption exponents as decimal strings).
 * MUST survive restart: if lost mid-shuffle the committed deck can't be
 * reproduced for role resolution and the game is unrecoverable (see spec §8).
 */
export function agentSraKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:sra:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/**
 * 4j pre-game — per-agent role-commit salt (64 hex chars, no 0x). Persisted so a
 * retry of commitAndConfirmRole reuses the same salt → same roleHash, and so the
 * later endgame role reveal can reproduce the commitment.
 */
export function agentRoleSaltKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:rolesalt:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/**
 * 4j pre-game — in-flight deck+salt for an agent's shuffle turn. Written BEFORE
 * commitDeck so a crash between commit and reveal is recoverable: on restart the
 * agent is DECK_COMMITTED on chain but un-revealed, and revealDeck needs the
 * exact deck+salt whose keccak matches the stored commit hash. Value is JSON
 * `{ deck: string[], salt: string }`. Cleared after a successful reveal.
 */
export function agentDeckCommitKey(
  chainId: number,
  roomId: string,
  agent: Hex
): string {
  return `${NS}:deckcommit:${chainId}:${roomId}:${agent.toLowerCase()}`;
}

/** 4j pre-game — TTL for SRA keys + role salt + in-flight deck. ~30 days (a game's max lifetime). */
export const PREGAME_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 4d DAY chat — TTL for chat prompt window / full log / ledger / suspicion / committed flag. */
export const DAY_CHAT_TTL_SECONDS = 24 * 60 * 60;

/** 4d DAY chat — TTL for persona pin (survives multi-day testing). */
export const PERSONA_TTL_SECONDS = 7 * 24 * 60 * 60;

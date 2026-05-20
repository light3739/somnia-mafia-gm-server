/**
 * agents/decision-schema.ts — LLM decision validator + deterministic fallback.
 *
 * The Somnia `inferString` primitive constrains output to `allowedValues`, but
 * the orchestrator still treats every response defensively:
 *   - response might not parse as a 20-byte address (validator failure);
 *   - LLM might return a value outside the alive set (model drift / proxy
 *     misbehaviour);
 *   - inference might fail entirely (status != Success, or timeout).
 *
 * Fallback is intentionally simple: the lowest-address alive non-self player.
 * Deterministic, so a re-run of the same room state picks the same target —
 * meaning the on-chain footprint is reproducible for demos and audit.
 *
 * Ported from SomniaMafia/e2e-bots/decision-schema.ts. Identical logic.
 */
import { getAddress, type Address } from "viem";

export type Action = "vote" | "kill" | "heal" | "check" | "skip";

export interface DecisionContext {
  /** Agent EOA making the decision. Excluded from "act on someone else" actions. */
  self: Address;
  /** Currently alive players (case-insensitive — we normalise). */
  alive: Address[];
  /** Action the agent is asked to take. */
  action: Action;
}

export interface DecisionResult {
  target: Address;
  /** "llm" if LLM picked a valid target, "fallback" if we synthesised one. */
  source: "llm" | "fallback";
  /** Reason for fallback — useful for logs/telemetry. */
  fallbackReason?: string;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

function normalise(addrs: Address[]): Address[] {
  return addrs
    .map((a) => {
      try {
        return getAddress(a);
      } catch {
        return ZERO;
      }
    })
    .filter((a) => a !== ZERO);
}

/**
 * Parse LLM string into an address. Tolerates leading/trailing whitespace,
 * code fences, JSON wrapping, extra commentary — we only need the 0x-prefixed
 * 40-hex substring.
 */
export function parseAddressFromLLM(raw: string): Address | null {
  if (!raw) return null;
  const hex = raw.match(/0x[a-fA-F0-9]{40}/);
  if (!hex) return null;
  try {
    return getAddress(hex[0]);
  } catch {
    return null;
  }
}

/**
 * Resolve a decision: parse LLM, validate against the alive pool, fall back if
 * invalid. Never returns ZERO; throws if no valid target exists at all.
 */
export function resolveDecision(
  llmResponse: string | null,
  ctx: DecisionContext
): DecisionResult {
  const alive = normalise(ctx.alive);
  const self = (() => {
    try {
      return getAddress(ctx.self);
    } catch {
      return ZERO;
    }
  })();
  const excludeSelf =
    ctx.action === "vote" || ctx.action === "kill" || ctx.action === "check";
  const pool = alive.filter((a) => !excludeSelf || a !== self);

  if (pool.length === 0) {
    throw new Error(
      `No valid targets for action ${ctx.action} (alive=${alive.length}, self=${self})`
    );
  }

  if (llmResponse) {
    const parsed = parseAddressFromLLM(llmResponse);
    if (parsed && pool.some((a) => a === parsed)) {
      return { target: parsed, source: "llm" };
    }
    return {
      target: deterministicPick(pool),
      source: "fallback",
      fallbackReason: parsed
        ? `parsed=${parsed} not in alive pool (${pool.length})`
        : `LLM response did not contain an address: ${JSON.stringify(llmResponse.slice(0, 80))}`,
    };
  }

  return {
    target: deterministicPick(pool),
    source: "fallback",
    fallbackReason: "no LLM response (timeout / failed status)",
  };
}

/** Lowest address wins. Stable across re-runs without RNG state. */
function deterministicPick(pool: Address[]): Address {
  return [...pool].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : 1
  )[0];
}

/** Build the prompt+allowedValues pair the LLM will see. Centralised so all phases share a single style. */
export function buildVotePrompt(args: {
  self: Address;
  alive: Address[];
  publicChat: { from: Address; text: string }[];
  privateMemory?: string[];
  dayCount: number;
  language?: string;
}): { prompt: string; system: string; allowedValues: string[] } {
  const lang = args.language ?? "English";
  const others = normalise(args.alive).filter((a) => a !== args.self);
  const chatLines = args.publicChat
    .slice(-15)
    .map((m) => `${m.from.slice(0, 6)}…: ${m.text}`)
    .join("\n");
  const privateMemory = args.privateMemory ?? [];

  return {
    system: [
      `You are a player in an on-chain Mafia game. Your wallet is ${args.self}.`,
      `Decide who to vote out today. Respond with EXACTLY one wallet address from the allowed list — no commentary, no prose.`,
      `Use private verified memory silently when choosing, but never quote it. If unsure, pick the most suspicious player based on the public chat. Never vote for yourself.`,
      `Reply language: ${lang}.`,
    ].join(" "),
    prompt: [
      `Day ${args.dayCount}.`,
      `Alive players (not you): ${others.join(", ")}`,
      `Recent public chat:`,
      chatLines || "(no messages yet)",
      privateMemory.length === 0
        ? `Private verified memory: (none)`
        : `Private verified memory:\n${privateMemory.join("\n")}`,
      ``,
      `Reply with one address from the allowed list. Address only.`,
    ].join("\n"),
    allowedValues: others,
  };
}

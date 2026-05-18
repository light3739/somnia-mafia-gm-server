/**
 * agents/scrubber.ts — Post-LLM role-leak filter for DAY chat.
 *
 * Pre-prompt instructs the LLM not to reveal role. This module is the
 * defense-in-depth: a regex-based outcome classifier that runs on every
 * raw LLM response before the message can be broadcast. Result includes
 * the rule version (SCRUB_VERSION) so commitments can later prove which
 * ruleset cleared the text.
 */
import { SCRUB_VERSION } from "./trace.js";

export const SCRUB_VERSION_EXPORT = SCRUB_VERSION;

export type ScrubResult =
  | { outcome: "ALLOWED"; sanitized: string; matches: string[]; scrubVersion: number }
  | { outcome: "BLOCKED_ROLE_LEAK"; sanitized: null; matches: string[]; scrubVersion: number }
  | { outcome: "EMPTY_RESPONSE"; sanitized: null; matches: string[]; scrubVersion: number };

const ROLE_CLAIM_PATTERNS: RegExp[] = [
  /\bi\s+am\s+(the\s+)?(detective|doctor|mafia|citizen)\b/i,
  /\bi['’]m\s+(a\s+|the\s+)?(detective|doctor|mafia|citizen)\b/i,
  /\bmy\s+role\s+is\s+(detective|doctor|mafia|citizen)\b/i,
  /\bas\s+(the\s+)?(detective|doctor|mafia)\b/i,
];

const ROLE_ACTION_PATTERNS: RegExp[] = [
  /\bi\s+checked\b/i,
  /\bi\s+healed\b/i,
  /\bi\s+killed\b/i,
  /\bi\s+investigated\b/i,
  /\bi\s+protected\b/i,
];

const ALL_PATTERNS = [...ROLE_CLAIM_PATTERNS, ...ROLE_ACTION_PATTERNS];

export function scrubText(rawText: string | null | undefined): ScrubResult {
  if (rawText == null) {
    return { outcome: "EMPTY_RESPONSE", sanitized: null, matches: [], scrubVersion: SCRUB_VERSION };
  }
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { outcome: "EMPTY_RESPONSE", sanitized: null, matches: [], scrubVersion: SCRUB_VERSION };
  }
  const matches: string[] = [];
  for (const pattern of ALL_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) matches.push(m[0]);
  }
  if (matches.length > 0) {
    return { outcome: "BLOCKED_ROLE_LEAK", sanitized: null, matches, scrubVersion: SCRUB_VERSION };
  }
  return { outcome: "ALLOWED", sanitized: trimmed, matches: [], scrubVersion: SCRUB_VERSION };
}

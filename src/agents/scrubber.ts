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
  | { outcome: "BLOCKED_TEMPORAL_HALLUCINATION"; sanitized: null; matches: string[]; scrubVersion: number }
  | { outcome: "BLOCKED_UNSUPPORTED_ATTRIBUTION"; sanitized: null; matches: string[]; scrubVersion: number }
  | { outcome: "EMPTY_RESPONSE"; sanitized: null; matches: string[]; scrubVersion: number };

export type ScrubOptions = {
  /**
   * First discussion day starts before any NIGHT phase. LLMs often import stock
   * Mafia phrasing ("what did you see last night") even though no such evidence
   * exists yet; block that before it reaches chat.
   */
  firstDiscussionDay?: boolean;
  /**
   * Display names of players with no supporting chat/log evidence in the current
   * prompt. Used to stop the LLM from inventing things like "why are you so
   * focused on X?" for someone who never spoke.
   */
  unsupportedAttributionNames?: string[];
};

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

const FIRST_DAY_NIGHT_REFERENCE_PATTERNS: RegExp[] = [
  /\bnight\b/i,
  /\btonight\b/i,
  /\bovernight\b/i,
  /\bwhat\s+(did|do|have)\s+.+\b(see|saw|seen)\b/i,
  /что\s+.+(видел|видела|видели)/iu,
  /ноч/iu,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unsupportedAttributionMatch(text: string, name: string): string | null {
  const clean = name.trim();
  if (clean.length < 2) return null;
  const n = escapeRegExp(clean);
  const patterns = [
    new RegExp(
      `${n}[^.!?\\n]{0,100}\\b(?:why\\s+(?:are\\s+you|you're)|you(?:'re|\\s+are)\\s+(?:so\\s+)?focused|your\\s+(?:focus|push|pressure|accusation)|you\\s+(?:said|claimed|accused|asked|suggested|pushed|pressured))\\b`,
      "i"
    ),
    new RegExp(
      `${n}[^.!?\\n]{0,100}\\b(?:is|was|seems|keeps?)\\s+(?:so\\s+)?(?:focused|pushing|pressuring|accusing)\\b`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m[0];
  }
  return null;
}

export function scrubText(
  rawText: string | null | undefined,
  options: ScrubOptions = {}
): ScrubResult {
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
  if (options.firstDiscussionDay) {
    const firstDayMatches: string[] = [];
    for (const pattern of FIRST_DAY_NIGHT_REFERENCE_PATTERNS) {
      const m = trimmed.match(pattern);
      if (m) firstDayMatches.push(m[0]);
    }
    if (firstDayMatches.length > 0) {
      return {
        outcome: "BLOCKED_TEMPORAL_HALLUCINATION",
        sanitized: null,
        matches: firstDayMatches,
        scrubVersion: SCRUB_VERSION,
      };
    }
  }
  const unsupportedMatches: string[] = [];
  for (const name of options.unsupportedAttributionNames ?? []) {
    const match = unsupportedAttributionMatch(trimmed, name);
    if (match) unsupportedMatches.push(match);
  }
  if (unsupportedMatches.length > 0) {
    return {
      outcome: "BLOCKED_UNSUPPORTED_ATTRIBUTION",
      sanitized: null,
      matches: unsupportedMatches,
      scrubVersion: SCRUB_VERSION,
    };
  }
  return { outcome: "ALLOWED", sanitized: trimmed, matches: [], scrubVersion: SCRUB_VERSION };
}

/**
 * agents/reveal-trace.ts — Pure post-game reveal driver.
 *
 * Enumerates every committed agent inference slot for an ENDED room, skips the
 * ones already revealed on-chain, loads the persisted trace material from Redis,
 * and calls the GM-only `revealAgentInferenceTrace` for each — emitting
 * `AgentInferenceRevealed`, which flips the frontend Agent Report badge from
 * "committed" to "verified".
 *
 * This module is pure: all chain/Redis access is injected via `RevealDeps`
 * (see reveal-deps.ts for the real wiring), so the logic is fully unit-testable.
 *
 * phaseId has two representations (load-bearing):
 *   - on-chain / commitment: keccak `makePhaseId(kind, day)` (bytes32)
 *   - Redis trace key:        the semantic label "D{day}-{KIND}" (events.ts)
 * `buildPhaseLabelMap` bridges them. The reveal call passes the keccak; the
 * Redis GET uses the label.
 */
import type { Address, Hex } from "viem";
import { makePhaseId, type AgentPhaseKind } from "./trace.js";

const KINDS: AgentPhaseKind[] = ["DAY", "VOTING", "NIGHT"];

/**
 * Reverse map keccak(phaseId) -> "D{day}-{KIND}" label, over all days of the
 * game. Mirrors AgentReport.tsx makePhaseLookup.
 */
export function buildPhaseLabelMap(dayCount: number): Map<string, string> {
  const map = new Map<string, string>();
  const days = Math.max(1, dayCount);
  for (let d = 1; d <= days; d++) {
    for (const kind of KINDS) {
      map.set(makePhaseId(kind, d).toLowerCase(), `D${d}-${kind}`);
    }
  }
  return map;
}

export interface RevealSlot {
  phaseIdHex: Hex;
  agent: Address;
  actionHash: Hex;
}

export interface TraceBlob {
  salt?: string;
  somniaRequestId?: string;
  promptHash?: string;
  responseHash?: string;
  actionHash?: string;
}

export interface RevealDeps {
  getRoom(roomId: bigint): Promise<{ phase: number; dayCount: number }>;
  getCommittedSlots(roomId: bigint): Promise<RevealSlot[]>;
  /** Set of "agent:phaseIdHex:actionHash" (all lowercase) already revealed on-chain. */
  getRevealedKeys(roomId: bigint): Promise<Set<string>>;
  /** Trace blob from Redis keyed by phase LABEL (not keccak). null = expired/absent. */
  getTrace(label: string, agent: Address): Promise<TraceBlob | null>;
  /** SETNX once-claim. true = we own the run; false = someone else already did. */
  claimRevealRun(): Promise<boolean>;
  sendReveal(slot: {
    roomId: bigint;
    phaseIdHex: Hex;
    agent: Address;
    somniaRequestId: bigint;
    promptHash: Hex;
    responseHash: Hex;
    actionHash: Hex;
    salt: Hex;
  }): Promise<Hex>;
}

export interface RevealReport {
  roomId: string;
  status: "ok" | "disabled" | "room-not-ended" | "already-claimed";
  total: number;
  revealed: number;
  skipped: { agent: string; phaseIdHex: string; reason: string }[];
  failed: { agent: string; phaseIdHex: string; reason: string }[];
  txHashes: string[];
}

export async function revealRoomTraces(
  { roomId }: { chainId: number; roomId: string },
  deps: RevealDeps
): Promise<RevealReport> {
  const report: RevealReport = {
    roomId,
    status: "ok",
    total: 0,
    revealed: 0,
    skipped: [],
    failed: [],
    txHashes: [],
  };

  if ((process.env.AGENTS_ENABLED ?? "").toLowerCase() !== "true") {
    report.status = "disabled";
    return report;
  }

  const roomIdBig = BigInt(roomId);
  const room = await deps.getRoom(roomIdBig);
  if (room.phase !== 6) {
    report.status = "room-not-ended";
    return report;
  }
  if (!(await deps.claimRevealRun())) {
    report.status = "already-claimed";
    return report;
  }

  const labelMap = buildPhaseLabelMap(room.dayCount);
  const slots = await deps.getCommittedSlots(roomIdBig);
  const revealedKeys = await deps.getRevealedKeys(roomIdBig);
  report.total = slots.length;

  for (const slot of slots) {
    const slotKey = `${slot.agent.toLowerCase()}:${slot.phaseIdHex.toLowerCase()}:${slot.actionHash.toLowerCase()}`;
    if (revealedKeys.has(slotKey)) continue;

    const label = labelMap.get(slot.phaseIdHex.toLowerCase());
    if (!label) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "unknown-phase" });
      continue;
    }

    const trace = await deps.getTrace(label, slot.agent);
    if (!trace) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "trace-expired" });
      continue;
    }
    if (
      !trace.salt ||
      trace.somniaRequestId == null ||
      !trace.promptHash ||
      !trace.responseHash ||
      !trace.actionHash
    ) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "trace-incomplete" });
      continue;
    }
    if (trace.actionHash.toLowerCase() !== slot.actionHash.toLowerCase()) {
      report.skipped.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: "actionhash-mismatch" });
      continue;
    }

    try {
      const hash = await deps.sendReveal({
        roomId: roomIdBig,
        phaseIdHex: slot.phaseIdHex,
        agent: slot.agent,
        somniaRequestId: BigInt(trace.somniaRequestId),
        promptHash: trace.promptHash as Hex,
        responseHash: trace.responseHash as Hex,
        actionHash: trace.actionHash as Hex,
        salt: trace.salt as Hex,
      });
      report.revealed += 1;
      report.txHashes.push(hash);
    } catch (err: any) {
      report.failed.push({ agent: slot.agent, phaseIdHex: slot.phaseIdHex, reason: String(err?.message ?? err) });
    }
  }

  return report;
}

/**
 * agents/trace.ts — Deterministic phaseId + traceCommitment builders.
 *
 * The Solidity AgentRegistryFacet (v3) computes traceCommitment as:
 *
 *   keccak256(abi.encode(
 *     TYPEHASH,           // keccak256("MAFIA_AGENT_TRACE_V1")
 *     block.chainid,
 *     address(this),      // Diamond address
 *     roomId,
 *     phaseId,
 *     agent,
 *     salt,
 *     somniaRequestId,
 *     promptHash,
 *     responseHash,
 *     actionHash
 *   ))
 *
 * This module reproduces that hash off-chain so the orchestrator can
 * pre-compute commitments before sending a tx, and verify them after
 * reveal. **The on-chain `computeTraceCommitment` view is the source
 * of truth** — always cross-check this builder against it in tests.
 *
 * phaseId is opaque to the contract; we standardise its construction
 * here so all orchestrator code, tests, and audit tools use the same
 * format.
 */
import {
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  toHex,
  type Hex,
} from "viem";

export const AGENT_TRACE_TYPEHASH = keccak256(toHex("MAFIA_AGENT_TRACE_V1"));

/** Phase enum values must match AgentEvent.type ordering in events.ts. */
export type AgentPhaseKind = "DAY" | "VOTING" | "NIGHT";

/**
 * Canonical phaseId: keccak256("D{dayNumber}-{kind}").
 *
 * Matches the in-memory `phaseId` strings already used in AgentEvent
 * (e.g. `"D3-VOTING"`) — we just hash them so they fit bytes32 on chain.
 */
export function makePhaseId(
  kind: AgentPhaseKind,
  dayNumber: number
): Hex {
  return keccak256(toHex(`D${dayNumber}-${kind}`));
}

export type TraceMaterial = {
  diamond: Hex;
  chainId: bigint;
  roomId: bigint;
  phaseId: Hex;
  agent: Hex;
  salt: Hex;
  somniaRequestId: bigint;
  promptHash: Hex;
  responseHash: Hex;
  actionHash: Hex;
};

/**
 * Compute the commitment exactly as the on-chain
 * `AgentRegistryFacet.computeTraceCommitment` would. Cross-checked in
 * SomniaSol test/AgentRegistryFacet.ts ("commit by registered agent
 * stores commitment and emits event").
 */
export function computeTraceCommitment(m: TraceMaterial): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, address, uint256, bytes32, address, bytes32, uint256, bytes32, bytes32, bytes32"
      ),
      [
        AGENT_TRACE_TYPEHASH,
        m.chainId,
        m.diamond,
        m.roomId,
        m.phaseId,
        m.agent,
        m.salt,
        m.somniaRequestId,
        m.promptHash,
        m.responseHash,
        m.actionHash,
      ]
    )
  );
}

/**
 * Generate a fresh 32-byte salt for an inference trace. Stored privately
 * in Redis alongside the trace material; revealed only post-GameEnded.
 *
 * Uses crypto.getRandomValues which is available in both Node 18+ and
 * Bun/Deno — no need for a separate Node 'crypto' import.
 */
export function randomSalt(): Hex {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let hex = "0x";
  for (const b of buf) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

export const AGENT_MESSAGE_TYPEHASH = keccak256(toHex("MAFIA_AGENT_MESSAGE_V2"));

/** Bump this whenever the scrubber regex / policy changes. The boolean
 *  scrubAllowed bound into messageHash plus this version pin the exact
 *  scrubber decision to a versioned ruleset. */
export const SCRUB_VERSION = 1;

export const MSG_KIND_REGULAR       = keccak256(toHex("MSG"));
export const MSG_KIND_SKIP_SCRUBBED = keccak256(toHex("SKIP_SCRUBBED"));

export type CommitStatus =
  | "PENDING_INFERENCE"
  | "PENDING_COMMIT"
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "COMMIT_CONFLICT"
  | "INFER_TIMEOUT"
  | "PHASE_ADVANCED"
  | "SPONSOR_LOW";

export type MsgKind = "MSG" | "SKIP_SCRUBBED";

export type ScrubOutcome = "ALLOWED" | "BLOCKED_ROLE_LEAK" | "EMPTY_RESPONSE";

export function messageTextHash(text: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }], [text])
  );
}

export function canonicalPromptHash(roles: string[], messages: string[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string[]" }, { type: "string[]" }],
      [roles, messages]
    )
  );
}

export type MessageMaterial = {
  chainId: bigint;
  diamond: Hex;
  roomId: bigint;
  phaseId: Hex;
  agent: Hex;
  salt: Hex;
  somniaRequestId: bigint;
  promptHash: Hex;
  rawResponseHash: Hex;
  sanitizedTextHash: Hex;
  scrubVersion: number;
  scrubAllowed: boolean;
  msgKind: Hex;
};

export function computeMessageHash(m: MessageMaterial): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, address, uint256, bytes32, address, bytes32, " +
        "uint256, bytes32, bytes32, bytes32, uint16, bool, bytes32"
      ),
      [
        AGENT_MESSAGE_TYPEHASH,
        m.chainId,
        m.diamond,
        m.roomId,
        m.phaseId,
        m.agent,
        m.salt,
        m.somniaRequestId,
        m.promptHash,
        m.rawResponseHash,
        m.sanitizedTextHash,
        m.scrubVersion,
        m.scrubAllowed,
        m.msgKind,
      ]
    )
  );
}

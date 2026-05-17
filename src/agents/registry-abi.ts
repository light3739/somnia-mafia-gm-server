/**
 * agents/registry-abi.ts — Inline ABIs for AgentRegistryFacet v3 and the
 * Diamond surface the agent subsystem needs (vote, getRoom, getPlayers).
 *
 * Why inline parseAbi instead of importing from src/abi.ts:
 *   - AgentRegistryFacet was deployed on testnet 2026-05-17 and added as a
 *     facet via Diamond.addFacet. The selectors route through the same Diamond
 *     address, but the canonical DIAMOND_ABI in src/abi.ts has not been
 *     regenerated yet (that's a separate sync-abi.ts step, scheduled
 *     post-4i once the agent flow is fully wired).
 *   - Inline parseAbi keeps 4b self-contained — no cross-repo regenerate step
 *     blocks merging.
 *
 * Selectors (canonical, from memory project_agent_registry_facet_deployed):
 *   0xc3e56d5d registerAgent
 *   0xbb106cd4 commitAgentInference
 *   0x7c9fbbc0 revealAgentInferenceTrace
 *   0xdf19c707 commitAgentMessage
 *   0x7e5aab91 commitAgentMemory
 *   0x6394fa9d isAgent
 *   0x1da9b2b6 getAgentPolicyHash
 *   0xd95314e9 getAgentModelHash
 *   0x0919ca05 getAgentMetadataHash
 *   0xdb47c6b4 getAgentTraceCommitment
 */
import { parseAbi } from "viem";

/**
 * AgentRegistryFacet v3 — subset needed by 4b (read isAgent + write commit).
 * Reveal and registration paths live in 4c-reveal and 4g respectively.
 */
export const AGENT_REGISTRY_ABI = parseAbi([
  // Reads
  "function isAgent(uint256 roomId, address player) view returns (bool)",
  "function getAgentTraceCommitment(uint256 roomId, bytes32 phaseId, address agent) view returns (bytes32)",
  // Writes
  "function commitAgentInference(uint256 roomId, bytes32 phaseId, bytes32 actionHash, bytes32 traceCommitment)",
  // Events
  "event AgentInferenceCommitted(uint256 indexed roomId, bytes32 indexed phaseId, address indexed agent, bytes32 actionHash, bytes32 traceCommitment)",
  "event AgentRegistered(uint256 indexed roomId, address indexed agent, bytes32 policyHash, bytes32 modelHash, bytes32 metadataHash)",
]);

/**
 * Tiny Diamond surface needed by the vote handler: getRoom + getPlayers shapes
 * the spike uses, plus vote(roomId, target). Mirrors the spike (where it was
 * inlined to keep e2e-bots free of cross-package imports).
 *
 * Player flags bit 0x4 = HAS_VOTED, 0x2 = ACTIVE — see src/types/contract.ts.
 */
export const DIAMOND_VOTE_ABI = parseAbi([
  "function getRoom(uint256) view returns ((uint64 id, address host, string name, uint8 phase, uint8 maxPlayers, uint8 playersCount, uint8 aliveCount, uint16 dayCount, uint8 currentShufflerIndex, uint32 lastActionTimestamp, uint32 phaseDeadline, uint8 confirmedCount, uint8 votedCount, uint8 committedCount, uint8 revealedCount, uint8 keysSharedCount, uint128 depositPool, uint128 depositPerPlayer, bool isPrivate, uint256 tournamentId))",
  "function getPlayers(uint256) view returns ((address wallet, string nickname, bytes publicKey, uint32 flags)[])",
  "function vote(uint256 roomId, address target)",
]);

/**
 * Lobby surface needed by 4g fill-room: joinRoom + getEntryFee.
 * registerAgent is in AGENT_REGISTRY_ABI above (commit/read mix); we mirror it
 * here implicitly via that ABI's `registerAgent` selector being callable on
 * the same Diamond proxy address.
 */
export const DIAMOND_LOBBY_ABI = parseAbi([
  "function joinRoom(uint256 roomId, string nickname, bytes publicKey, address sessionAddress, bytes gmSignature) payable",
  "function getEntryFee() view returns (uint128)",
]);

/**
 * Extended registry surface used by 4g: registerAgent (GM-only write).
 * Kept separate from AGENT_REGISTRY_ABI so 4b doesn't import a write fn it
 * never needs.
 */
export const AGENT_REGISTRY_WRITE_ABI = parseAbi([
  "function registerAgent(uint256 roomId, address agent, bytes32 policyHash, bytes32 modelHash, bytes32 metadataHash)",
]);

/**
 * Compute the actionHash bound into the vote trace. The exact bytes are not
 * defined on chain (`AgentRegistryFacet.commitAgentInference` accepts an
 * opaque bytes32) but we standardise here so audit tools can recompute it
 * deterministically from a known vote target.
 *
 * Layout:  keccak256(abi.encode("VOTE", target))
 *
 * Kept as a single export instead of inlined per-call so the convention is
 * documented in one place and the night/day handlers can mirror it.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export function voteActionHash(target: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }],
      ["VOTE", target]
    )
  );
}

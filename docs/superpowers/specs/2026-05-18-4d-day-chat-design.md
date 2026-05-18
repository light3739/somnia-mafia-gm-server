# Task 4d — DAY chat design

**Status:** approved 2026-05-18 (brainstorming phase + post-review fixes). Implementation plan TBD.

**Scope:** Implement the DAY phase chat handler for SomniaMafia agents. Each
agent generates one in-character message per DAY phase via Somnia's on-chain
`inferChat` primitive. Messages are role-scrubbed, committed on chain via
**new** `commitAgentMessageV2(roomId, phaseId, messageHash)` (Solidity facet
upgrade — see Section 1), broadcast over WebSocket, and persisted to Redis
for per-agent memory.

**Review fixes (2026-05-18 round 2):** F1–F6 from independent code review,
all locked. Highlights: V2 contract with on-chain phase-scoped dedup
(F1); full Somnia provenance bound into `messageHash` (F2); second phase
re-check immediately before commit tx (F3); split `commitStatus` and
`msgKind` to fix SCRUBBED_SKIP contradiction (F4); realistic
`LLM_CHAT_WAIT_MS=25000` based on observed latency (F5); v1 ledger and
suspicion update from chain events only — chat extraction deferred to
Memory Engine Days 8-9 (F6).

**Review fixes (2026-05-18 round 3 — F-new):** five additional findings, all
locked. (F-new-1) Reject `messageHash == bytes32(0)` in contract via
`ZeroMessageHash` revert — zero is the dedup sentinel and must not be
writable. (F-new-2) Remove `somniaRequestId` from WS broadcast payload —
the corresponding Somnia `RequestCreated` event leaks the prompt
mid-game per [[agent-role-secrecy]]; keep requestId in private Redis
trace only until reveal. (F-new-3) On `MessageAlreadyCommitted` revert,
read `getAgentMessageHash` and distinguish self-retry (stored hash ==
our hash → success-equivalent) from race conflict (stored != ours → new
`COMMIT_CONFLICT` status, no chat/WS mutation). (F-new-4) Reorder
lifecycle: compute hashes → F3 phase recheck → persist appropriate
state → tx. Avoids stale `PENDING_COMMIT` write when phase advances.
(F-new-5) Update chain event ID sources: `NightResolvedByGM` and
`NightFinalized` from `LibGame.sol:115,127` — there is no `NightEnded`
event. **Minor:** `scrubResult.outcome` enum (`ALLOWED |
BLOCKED_ROLE_LEAK | EMPTY_RESPONSE`) replaces ambiguous
`scrubAllowed=true` on empty response; the boolean bound into
`messageHash` derives as `outcome === "ALLOWED"`.

**Review fixes (2026-05-18 round 4 — F-new-round4):** (F-new-round4-1)
Reason-agnostic commit failure recovery — `waitForReceiptOrRevert`
(chain-ops.ts:45) throws a generic `"... reverted on chain"` without
custom-error data, so the handler cannot branch on revert reason.
Replaced the round-3 three-way branch (by revert reason) with a
**single tri-way branch on `chain.getAgentMessageHash(...)` after any
commit failure**: stored == our hash → success-equivalent; stored != 0
and != ours → `COMMIT_CONFLICT`; stored == 0 → `COMMIT_FAILED`. Same
final states, but does not depend on RPC error-string parsing.
(F-new-round4-2) Corrected the V2 upgrade smoke checklist line for the
zero-hash test: after a `ZeroMessageHash` revert on a fresh slot,
storage stays unset, so the next non-zero commit must **succeed**, and
only the second non-zero commit reverts with
`MessageAlreadyCommitted`.

**Position in master plan:** Day 6 deliverable in the 22-day Agentathon track.
Follows 4f NIGHT (done) and 4b VOTING (done). Pre-reqs all met.

**Out of scope (deferred to later tasks):**
- Full structured Memory Engine (Days 8-9)
- DAY → VOTING → NIGHT E2E integration (4i)
- Listener backfill / restart resilience (4i pre-req)
- FE chat UI (Days 10-12)
- Audit endpoint integration ([[audit-stats-plan]])

## Locked macro-decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | On-chain `inferChat` for every DAY message | Strongest jury narrative ("every word verifiable"). Testnet free. Mainnet ~0.24 STT per call — acceptable. |
| 2 | Sequential round-robin, 1 message per agent per DAY phase, rotating offset by `dayCount` | Bounded cost, deterministic ordering, fairness across days. |
| 3 | Pre-prompt instruction + post-LLM regex scrubber → publish sanitized | Defense in depth. Pre-prompt cheap; regex catches LLM failures to follow instructions. |
| 4 | Memory v1: event-pinned ledger + per-agent suspicion/trust vector + last 20 chat msgs in prompt | Zero extra LLM cost. Ledger / suspicion updated **only from chain-derived events** (votes, deaths) in v1. Chat is shown to agents for context but **not parsed into structured events** — that work belongs to Memory Engine Days 8-9. **(F6)** |
| 5 | Suspicion vector updates via deterministic heuristic rules from chain events | Zero LLM cost, debuggable, jury-explainable. No fragile chat regex extractor in v1. **(F6)** |
| 6 | Persona: EOA-deterministic from hardcoded pool of 10, pinned at fill-room time | Wallet-bound identity, reproducible, no extra inference cost. |
| 7 | Split `commitStatus` (lifecycle) and `msgKind` (path taken) into orthogonal fields | Fixes F4 SCRUBBED_SKIP contradiction. Reveal eligibility: `commitStatus == COMMITTED` regardless of `msgKind`. |
| 8 | inferChat timeout → keep action key held, agent silent for that DAY | Divergence from NIGHT (which releases on throw). Rationale: DAY chat silence is non-game-breaking; preventing duplicate cost / phantom commits is higher value. |
| 9 | Role load miss → generic neutral prompt, not CITIZEN fallback | Safer: cannot accidentally tell LLM it is a citizen when role storage is broken. |
| 10 | Sponsor budget guard skips inference if balance below threshold | Protects against single-game sponsor drain. Skip logged with structured reason. |
| 11 | **AgentRegistryFacet contract upgrade**: new `commitAgentMessageV2(roomId, phaseId, messageHash)` with on-chain dedup storage + getter + revert on double-commit per `(roomId, phaseId, agent)` | Fixes F1. Makes DAY chat symmetric with `commitAgentInference`. Enables restart resilience via chain-event-only reconstruction without Redis. |
| 12 | **`messageHash` binds full Somnia provenance** (somniaRequestId, promptHash, rawResponseHash, sanitizedTextHash, scrubVersion, scrubAllowed, msgKind) | Fixes F2. Audit-revealable proof that on-chain commit was derived from a specific Somnia `inferChat` request, with explicit scrubber accountability. |
| 13 | **Second phase re-check immediately before `commitAgentMessageV2` tx** | Fixes F3. inferChat wait can be 5–25s; phase can advance during wait. Re-check after scrub, abort with `PHASE_ADVANCED` if no longer DAY. |
| 14 | `LLM_CHAT_WAIT_MS = 25000` based on observed Somnia chat latency (3.8–5.8s) | Fixes F5 timing math. 4 agents × 28s + 10s buffer = ~122s → `DAY_PHASE_SECONDS ≥ 150`. |

## Section 1 — Architecture

### Handler lifecycle (mirror NIGHT pattern)

```
DAY_STARTED event (chain listener → AgentEventBus)
  → DayHandler.handle(event)
    → enumerate agents (chain.getPlayers + isAgent)
    → match to HD-derived wallets (matchWalletsToAgents)
    → compute rotating round-robin order: agentsSorted with offset = dayCount % len
    → for each agent in order:
        # ---- pre-checks ----
        check phase still DAY (chain.getRoom) — abort with PHASE_ADVANCED if not
        claim agents:action:{chainId}:{roomId}:{phaseId}:{agent}:day-chat (NX, EX=24h)
        if claim fails → skipped-action-idempotent
        # F1: existing-commit check now reads on-chain V2 getter
        existing = chain.getAgentMessageHash(roomIdBig, phaseIdHex, agent)
        if existing != ZERO_BYTES32 → skipped-already-committed
        load role, persona, ledger, suspicion, last 20 chat, alivePlayers
        check sponsor balance → if low: commitStatus=SPONSOR_LOW, persist skip reason, return
        persist trace with commitStatus=PENDING_INFERENCE
        build prompt (system + persona + role-aware lines OR neutral if role missing)
        call llm-chat-call.inferChatOnSomnia (uses LLMChatResultStore)
        if timeout: commitStatus=INFER_TIMEOUT, action key STAYS HELD, return
        if response empty/null: route as scrubbed-empty (msgKind=SKIP_SCRUBBED, scrubAllowed=true sentinel? — see Section 2)
        scrub(rawText) returns {allowed, reason, sanitized, matches, scrubVersion}
        if !allowed:
          msgKind = SKIP_SCRUBBED
          sanitizedTextHash = ZERO_BYTES32
          (no WS broadcast)
        else:
          msgKind = MSG
          sanitizedTextHash = messageTextHash(sanitized)
        # Compute all hashes BEFORE any state persist or phase recheck (F-new-4 order fix)
        salt = randomSalt()
        rawResponseHash = keccak(toHex(rawText))
        promptHash = canonicalPromptHash(roles, messages)   # keccak of (string[], string[])
        sanitizedTextHash = msgKind == MSG ? messageTextHash(sanitized) : ZERO_BYTES32
        messageHash = computeMessageHash(F2-full preimage — see Section 2)
        # F3: second phase re-check BEFORE persisting PENDING_COMMIT (F-new-4 fix)
        recheckPhase = chain.getRoom(roomId).phase
        if recheckPhase != PHASE_DAY:
          persist trace { commitStatus=PHASE_ADVANCED, msgKind, all material — kept for debug }
          return  # no tx, no broadcast
        persist trace with commitStatus=PENDING_COMMIT (includes all provenance fields)
        send commitAgentMessageV2(roomId, phaseId, messageHash) from agent EOA
        waitForReceiptOrRevert
        on success:
          commitStatus=COMMITTED
          set agentMessageCommittedKey flag in Redis (optimisation cache; chain getter is source of truth)
          if msgKind == MSG:
            redis.rpush(agentChatPromptKey) + LTRIM last 20
            redis.rpush(agentChatLogKey)
            # F6: NO chat-event extraction in v1. Suspicion/ledger only update from chain events elsewhere.
            # F-new-2: somniaRequestId MUST NOT appear in WS payload — public chain has the corresponding
            # RequestCreated event with prompt payload, revealing requestId mid-game = role leak.
            wsManager.broadcastToRoom(roomId, chainId, {type:"agent-chat", by, text, persona, day, messageHash, commitTxHash})
        on commit revert (F-new-round4-1 reason-agnostic — revert data not surfaced by waitForReceiptOrRevert):
          stored = chain.getAgentMessageHash(roomId, phaseId, agent)
          if stored == messageHash:
            commitStatus=COMMITTED   # idempotent retry of OUR own commit (e.g., post-restart)
            (proceed with all on-success side effects)
          elif stored != ZERO_BYTES32:
            commitStatus=COMMIT_CONFLICT   # different hash on chain — our text is NOT what got committed
            action key STAYS HELD
            NO chat/ledger/suspicion/WS mutations
          else:   # stored == 0
            commitStatus=COMMIT_FAILED   # true failure (impossible-ZeroMessageHash, NotAgent, paused, gas, etc)
            action key STAYS HELD
            no chat/ledger/suspicion/WS mutations
    → log outcomes
```

### Files

```
gm-server/src/agents/day.ts            new  DayHandler + handleOneAgent + buildDayPrompt
gm-server/src/agents/llm-chat-call.ts  new  inferChatOnSomnia wrapper (mirror llm-tools-call.ts)
gm-server/src/agents/scrubber.ts       new  scrubText(text) → {allowed, reason, sanitized, matches}
gm-server/src/agents/suspicion.ts      new  applySuspicionEvent + heuristic rules + idempotency set
gm-server/src/agents/ledger.ts         new  ledger ops (append vote/kill/accusation/claim/defense)
gm-server/src/agents/personas.ts       new  POOL[10] + pickPersonaByEoa(addr) + getOrPinPersona
gm-server/src/agents/dispatcher.ts     edit DAY_STARTED → DayHandler.handle wire
gm-server/src/agents/index.ts          edit instantiate DayHandler in agent system bootstrap
gm-server/src/agents/registry-abi.ts   edit + commitAgentMessageV2 write fn + AgentMessageCommittedV2 event
                                            + getAgentMessageHash view fn (chain getter for F1 dedup)
gm-server/src/agents/redis-keys.ts     edit + agentChatPromptKey, agentChatLogKey, agentLedgerKey,
                                            agentSuspicionKey, agentPersonaKey,
                                            agentSuspicionProcessedKey, agentSkipReasonKey,
                                            agentMessageCommittedKey (optimisation cache only),
                                            extend agentActionProcessedKey "day-chat" tag
gm-server/src/agents/trace.ts          edit + AGENT_MESSAGE_TYPEHASH + computeMessageHash (F2 full preimage)
                                            + messageTextHash + canonicalPromptHash
                                            + CommitStatus union + MsgKind union (F4 split fields)
                                            + SCRUB_VERSION constant
gm-server/src/scripts/smoke-chat-result-store.mjs  new  standalone LLM smoke
gm-server/src/scripts/smoke-day-chat.ts            new  full DAY handler smoke
gm-server/test/agents/day.test.ts                  new  ~25 handler tests (includes F3 phase-during-infer,
                                                        F4 scrubbed final-state, F5 timing observation)
gm-server/test/agents/scrubber.test.ts             new  false-positive cases + policy result shape
gm-server/test/agents/personas.test.ts             new  deterministic snapshot + sane distribution
gm-server/test/agents/suspicion.test.ts            new  heuristic rules + eventId idempotency
gm-server/test/agents/ledger.test.ts               new  chain-event-only sources (v1)
gm-server/test/agents/llm-chat-call.test.ts        new  payload encoding + timeout + late-result-ignored
gm-server/test/agents/messageHash.test.ts          new  F2 provenance binding + F1 cross-phaseId

SomniaSol/contracts/LLMChatResultStore.sol         new  single-string result store + PLATFORM guard
SomniaSol/scripts/deploy-llm-chat-store.ts         new  testnet + mainnet
SomniaSol/test/LLMChatResultStore.ts               new  handleResponse decode + guard
SomniaSol/contracts/facets/AgentRegistryFacet.sol  edit + commitAgentMessageV2 + getAgentMessageHash + AgentMessageCommittedV2
                                                        + storage mapping[roomId][phaseId][agent] => messageHash
                                                        + revert on double-commit (F1 strong dedup)
                                                        + LibStorage extension (Diamond storage-safe append)
SomniaSol/scripts/upgrade-agent-registry-v4.ts     new  facet upgrade script (replace old facet via diamondCut)
SomniaSol/test/AgentRegistryFacet.ts               edit + V2 message commit tests + dedup revert tests
                                                        + ZeroMessageHash revert test (F-new-1)
                                                        + getAgentMessageHash read tests
```

### Reuse from existing 4b/4f/4g

- `chain-ops.ts` send-pattern (sponsor top-up → tx → receipt verify) — replicate for
  `sendCommitMessageV2(agent, roomId, phaseId, messageHash, gasPriceGwei)`.
- `sponsor.ts` top-up flow.
- `wallets.ts` HD derivation + `matchWalletsToAgents`.
- `trace.ts` `randomSalt`, `makePhaseId("DAY", dayCount)`.
- `roles.ts` `getAgentRole`.
- DI / idempotency 3-layer (action key + active check + on-chain existing-commit check).
  **F1 update:** existing-commit check now reads on-chain
  `getAgentMessageHash(roomId, phaseId, agent)` — same shape as NIGHT's
  `getAgentTraceCommitment`. Redis flag `agentMessageCommittedKey` kept as a
  fast-path cache but the chain getter is authoritative. Restart resilience now
  works **without Redis** — scan AgentMessageCommittedV2 events or call getter
  per (roomId, phaseId, agent) on listener startup.

### AgentRegistryFacet upgrade (F1 fix — strong on-chain dedup)

Add (without modifying existing functions / events / storage layout):

```solidity
// New storage in LibStorage.AppStorage (append-only — Diamond storage-safe):
// mapping(uint256 roomId => mapping(bytes32 phaseId => mapping(address agent => bytes32))) agentMessageHash;

event AgentMessageCommittedV2(
    uint256 indexed roomId,
    bytes32 indexed phaseId,
    address indexed agent,
    bytes32 messageHash
);

error MessageAlreadyCommitted();
error ZeroMessageHash();   // F-new-1: bytes32(0) is the "not committed" sentinel — reject it as input

/// @notice Commit hash of an off-chain agent DAY-phase chat message.
///         Enforces dedup per (roomId, phaseId, agent) — replay-safe and
///         symmetric with commitAgentInference. Old commitAgentMessage retained
///         for backward compatibility but is no longer called by DAY handler.
///
///         **F-new-1:** rejects messageHash == bytes32(0). Otherwise a caller
///         could write zero into storage and bypass the dedup check forever
///         (zero is the "empty slot" sentinel).
function commitAgentMessageV2(
    uint256 roomId,
    bytes32 phaseId,
    bytes32 messageHash
) external {
    LibGame.requireNotPaused();
    if (messageHash == bytes32(0)) revert ZeroMessageHash();
    address agent = LibGame.resolvePlayer(roomId);
    if (!LibStorage.s().isAgent[roomId][agent]) revert NotAgent();
    if (LibStorage.s().agentMessageHash[roomId][phaseId][agent] != bytes32(0)) {
        revert MessageAlreadyCommitted();
    }
    LibStorage.s().agentMessageHash[roomId][phaseId][agent] = messageHash;
    emit AgentMessageCommittedV2(roomId, phaseId, agent, messageHash);
}

function getAgentMessageHash(
    uint256 roomId,
    bytes32 phaseId,
    address agent
) external view returns (bytes32) {
    return LibStorage.s().agentMessageHash[roomId][phaseId][agent];
}
```

Upgrade procedure (must follow [[task-4f-night-done]] PK-strip gotcha):
1. Compile new AgentRegistryFacet (Hardhat).
2. Run `scripts/upgrade-agent-registry-v4.ts` — diamondCut REPLACE existing facet
   address (keep prior selectors) and ADD the two new selectors.
3. Verify on testnet: `getAgentMessageHash(0, 0x0, address(0))` returns
   `0x000...` (sanity probe — new storage slot is zero by default).
4. Update `[[agent-registry-facet-deployed]]` memory with new commit + facet
   address (if address changes due to redeploy).

### LLMChatResultStore (new contract)

Single-string `inferChat` result store, mirroring LLMToolsResultStore structure but
decoding a single `(string)` instead of the 6-tuple. PLATFORM guard required —
mirror existing pattern (LLMToolsResultStore.sol:77).

```solidity
contract LLMChatResultStore {
    enum ResponseStatus { None, Pending, Success, Failed, TimedOut }
    struct Response { address validator; bytes result; ResponseStatus status;
                      uint256 receipt; uint256 timestamp; uint256 executionCost; }
    struct Request  { /* mirror AgentRequester */ }

    address public immutable PLATFORM;
    struct StoredResult { bool ready; ResponseStatus status; string response; }
    mapping(uint256 => StoredResult) internal _results;

    event ChatResultReady(uint256 indexed requestId, ResponseStatus status);
    event ChatResultFailed(uint256 indexed requestId, ResponseStatus status);

    constructor(address platform) { PLATFORM = platform; }

    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory /* details */
    ) external {
        require(msg.sender == PLATFORM, "not platform");
        StoredResult storage s = _results[requestId];
        s.ready = true;
        s.status = status;
        if (status == ResponseStatus.Success && responses.length > 0) {
            string memory resp = abi.decode(responses[0].result, (string));
            s.response = resp;
            emit ChatResultReady(requestId, status);
        } else {
            emit ChatResultFailed(requestId, status);
        }
    }

    function getResult(uint256 requestId) external view returns (StoredResult memory) {
        return _results[requestId];
    }

    receive() external payable {}
}
```

## Section 2 — Data flow + storage

### Redis keys (extend `redis-keys.ts`)

```typescript
agentChatPromptKey(chainId, roomId)         // LIST, LTRIM last 20, prompt window
agentChatLogKey(chainId, roomId)            // LIST, append-only full log, EX=24h, audit/replay
agentLedgerKey(chainId, roomId)             // STRING (JSON): {votes,kills,accusations,claims,defenses}
agentSuspicionKey(chainId, roomId, agent)   // STRING (JSON): {suspicion, trust, notes[]}
agentSuspicionProcessedKey(chainId, roomId, agent)  // SET, processed eventIds, EX=24h
agentPersonaKey(chainId, roomId, agent)     // STRING, persona text, EX=7d
agentSkipReasonKey(chainId, roomId, phaseId, agent)  // STRING, observability, EX=24h
agentMessageCommittedKey(chainId, roomId, phaseId, agent)  // FLAG "1", EX=24h, replay guard
// existing reused: agentActionProcessedKey, agentTraceKey, agentRoleKey
```

### Persona pin (at fill-room time, with deterministic miss fallback)

```typescript
// fill-room.ts (extend existing)
for each new agent EOA:
  persona = POOL[BigInt(keccak256(addr)) % 10n]
  redis.set(agentPersonaKey, persona, "EX", 7*24*3600)

// day.ts on every turn:
async function getOrPinPersona(redis, chainId, roomId, addr): Promise<string> {
  const key = agentPersonaKey(chainId, roomId, addr);
  let p = await redis.get(key);
  if (!p) {
    p = POOL[BigInt(keccak256(addr)) % 10n];
    await redis.set(key, p, "EX", 7*24*3600);
    log.warn({addr}, "persona miss, recomputed");
  }
  return p;
}
```

POOL initial proposal (10 entries; expand to 20 if observable collisions in demo):

```
1. calm logical analyst
2. loud sceptical accuser
3. quiet observer
4. nervous over-explainer
5. dry sarcastic joker
6. cautious pragmatic mediator
7. paranoid suspicious sceptic
8. bold confident leader voice
9. soft empathic peacemaker
10. blunt impatient pragmatist
```

### Canonical text/message hashing helpers (`trace.ts`) — F2 full preimage

`messageHash` is the on-chain commitment for one DAY chat message. Its
preimage binds **all Somnia provenance** so that post-game reveal proves the
published text came from a specific Somnia `inferChat` request and passed a
specific scrubber version.

```typescript
export const AGENT_MESSAGE_TYPEHASH = keccak256(toHex("MAFIA_AGENT_MESSAGE_V2"));

/** Bump this whenever scrubber regex / policy changes — binds the scrub decision to a versioned ruleset. */
export const SCRUB_VERSION = 1;

export const MSG_KIND_REGULAR       = keccak256(toHex("MSG"));
export const MSG_KIND_SKIP_SCRUBBED = keccak256(toHex("SKIP_SCRUBBED"));

export function messageTextHash(text: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }], [text])
  );
}

/**
 * Canonical prompt hashing: hash a (roles[], messages[]) array pair. This is
 * what the inferChat wrapper sends to Somnia, so it is what we bind into the
 * commitment. Encoded as parallel string arrays to mirror the Solidity
 * primitive signature.
 */
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
  somniaRequestId: bigint;   // F2: ties on-chain commit to a specific Somnia request
  promptHash: Hex;           // F2: canonical hash of (roles, messages) array pair
  rawResponseHash: Hex;      // F2: raw LLM output, pre-scrub
  sanitizedTextHash: Hex;    // F2: post-scrub published text (ZERO_BYTES32 if SKIP_SCRUBBED)
  scrubVersion: number;      // F2: version of regex / policy used
  scrubAllowed: boolean;     // F2: did scrubber permit publish (false → SKIP_SCRUBBED path)
  msgKind: Hex;              // MSG_KIND_REGULAR | MSG_KIND_SKIP_SCRUBBED
};

export function computeMessageHash(m: MessageMaterial): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, address, uint256, bytes32, address, bytes32," +
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
```

### CommitStatus + MsgKind split (`trace.ts`) — F4 fix

`commitStatus` describes lifecycle progress (where the handler stopped).
`msgKind` describes which path was taken (MSG or SKIP_SCRUBBED). These are
orthogonal. A `SCRUBBED_SKIP` message that successfully commits has
`commitStatus="COMMITTED"` AND `msgKind="SKIP_SCRUBBED"` — no contradiction.

```typescript
export type CommitStatus =
  | "PENDING_INFERENCE"   // inferChat dispatched, waiting for result
  | "PENDING_COMMIT"      // result received + scrubbed, about to send commit tx
  | "COMMITTED"           // commit tx mined successfully
  | "COMMIT_FAILED"       // commit tx reverted (non-dedup); action key STAYS HELD
  | "COMMIT_CONFLICT"     // F-new-3: dedup revert + on-chain hash differs from our local hash
  | "INFER_TIMEOUT"       // no ChatResultReady within waitMs; action key STAYS HELD
  | "PHASE_ADVANCED"      // F3: room no longer in DAY at recheck before commit; no tx sent
  | "SPONSOR_LOW";        // sponsor below threshold; no inference, no commit

export type MsgKind =
  | "MSG"                 // sanitized text published
  | "SKIP_SCRUBBED";      // scrubber blocked OR LLM returned empty → SKIP commit

/** F-new-minor: explicit scrub outcome for cleaner code semantics; the boolean
 *  scrubAllowed used in computeMessageHash is derived as (outcome === "ALLOWED"). */
export type ScrubOutcome =
  | "ALLOWED"             // sanitized text safe to publish
  | "BLOCKED_ROLE_LEAK"   // regex matched role-revealing pattern; publish suppressed
  | "EMPTY_RESPONSE";     // LLM returned empty/whitespace; treated as non-publishable
```

**Reveal eligibility** (post-game audit endpoint, future): `commitStatus ==
"COMMITTED"`. Both `msgKind == "MSG"` and `msgKind == "SKIP_SCRUBBED"` are
revealable — the SKIP path is part of the audit trail. Other statuses
(`COMMIT_FAILED`, `COMMIT_CONFLICT`, `INFER_TIMEOUT`, `PHASE_ADVANCED`,
`SPONSOR_LOW`) remain private since no on-chain commitment matching our local
trace exists; revealing their prompt could leak strategy without a verifiable
anchor (the `COMMIT_CONFLICT` case is especially sensitive — chain shows a
*different* hash that we did not produce).

### Suspicion event idempotency — F6 v1 scope

In v1, **only chain-derived events** feed the ledger and suspicion vector.
Free-form chat is logged but **not parsed** into structured ACCUSATION /
DEFENSE / ROLE_CLAIM events. That parsing belongs in the Days 8-9 Memory
Engine where LLM-assisted extraction makes the brittleness tractable.

```typescript
type SuspicionEvent = {
  eventId: string;  // stable per source
  kind: "VOTE" | "KILL";  // v1: chain-derived only
  // ...payload
};

async function applySuspicionEvent(state, event, redis, processedKey) {
  const isMember = await redis.sismember(processedKey, event.eventId);
  if (isMember) return state;
  await redis.sadd(processedKey, event.eventId);
  await redis.expire(processedKey, 24*3600);
  // apply heuristic mutation, return new state
}
```

Event ID sources (F-new-5 fix — use actual events from `LibGame.sol`):
- VOTE chain events (PlayerVoted log): `vote-${txHash}-${logIndex}`
- KILL via `NightResolvedByGM(roomId, killed, healed)` — emitted by `NightFacet.resolveNightAsGameMaster` (`NightFacet.sol:37`): `nightGM-${txHash}-${logIndex}`
- KILL via `NightFinalized(roomId, killed, healed)` — emitted on peaceful timeout / no-action path (`LibGame.sol:389`): `nightFin-${txHash}-${logIndex}`
- Both KILL events have shape `(roomId, killed, healed)`; treat `killed != address(0)` as the kill signal. `healed != address(0)` is informational only (used later in reveal phase).
- (Deferred to Memory Engine) chat-derived events would use
  `chat-${commitTxHash}` once an extractor exists.

### Heuristic rules (`suspicion.ts`) — v1 chain-only

```
VOTE event (from chain), voter X → target Y:
  for all agents A (A != X):
    # Without chat-event extraction, "Y previously accused A" cannot be derived.
    # v1 falls back to a coarse-but-meaningful signal: voting against agent A
    # raises A's suspicion of X.
    if Y == A:
      A.suspicion[X] += 0.15
      A.notes.push("Day N: X voted against me")
    else:
      A.suspicion[X] += 0.02  // mild "X is engaging"
      A.notes.push("Day N: X voted for Y")

KILL event (night death revealed), victim V:
  # Mafia killed V last night — no information about who is mafia available
  # to the alive agents (this is exactly the deduction problem of the game).
  # v1: only log the death into ledger; do not mutate suspicion vector — any
  # heuristic at this point would be guesswork that risks misleading the agent.
  ledger.kills.push({day: N, victim: V})
  # (suspicion vector unchanged)
```

Cap all scores at `[0, 1]`. Notes truncated to last 20.

**Anticipated upgrade path (Days 8-9):** when the chat extractor lands, add
back the richer rules (ACCUSATION +0.15, DEFENSE +0.10, KILL "previously
accused" +0.05 weak signal, ROLE_CLAIM +0.05) without changing the v1 chain
rules.

### Ledger growth notes

For v1, DayHandler runs sequentially per room → ledger mutation race not possible
in-instance. For multi-instance prod (out of 4d scope), ledger updates must use
Redis WATCH/MULTI or Lua script. Documented in handler comment.

Ledger v1 schema (chain-derived only):
```json
{
  "votes":  [{ "day": 2, "from": "0x...", "to": "0x...", "txHash": "0x...", "logIndex": 3 }],
  "kills":  [{ "day": 2, "victim": "0x..." }],
  "deaths": [{ "day": 2, "player": "0x...", "cause": "night-kill" | "day-vote" }]
}
```
(`accusations`, `claims`, `defenses` fields planned but unpopulated in v1;
schema reserves them so Days 8-9 can fill without ledger version bump.)

## Section 3 — Error handling

### State transitions (F4 split — commitStatus tracks lifecycle, msgKind tracks path)

```
Per-agent turn:
  On infer dispatch:                       commitStatus = PENDING_INFERENCE
  On infer timeout (no result in waitMs):  commitStatus = INFER_TIMEOUT      (terminal)  msgKind = (n/a)
  On infer success, scrub allowed:         commitStatus = PENDING_COMMIT     msgKind = MSG
  On infer success, scrub blocked OR
    response empty/whitespace:             commitStatus = PENDING_COMMIT     msgKind = SKIP_SCRUBBED
  On F3 phase recheck before commit fails: commitStatus = PHASE_ADVANCED     (terminal)
  On commit success:                       commitStatus = COMMITTED          (terminal, msgKind preserved)
  On commit revert:                        commitStatus = COMMIT_FAILED      (terminal, msgKind preserved)
  On sponsor balance under threshold:      commitStatus = SPONSOR_LOW        (terminal, no msgKind)
```

`msgKind` is decided in the scrub step and **does not change** afterwards.
`commitStatus` advances independently. A successfully committed SKIP
message ends with `(commitStatus=COMMITTED, msgKind=SKIP_SCRUBBED)`. No
contradiction.

### Failure response table

| Stage | Failure | Response |
|---|---|---|
| Action key claim | already held | Skip — `skipped-action-idempotent`. Other run handles. |
| On-chain dedup check (F1) | `getAgentMessageHash(roomId, phaseId, agent) != 0` | Skip — `skipped-already-committed`. Release action key (safe — chain shows truth). |
| Role load Redis miss | role missing | **Generic neutral prompt, NOT citizen.** System prompt explicit: "You don't know your role; speak only generic social observations." Continue normally. |
| Sponsor balance check | `< SPONSOR_LOW_THRESHOLD_STT` | Skip; commitStatus=`SPONSOR_LOW`; persist `agentSkipReasonKey = "sponsor-low-no-inference"`. No inference, no commit. |
| `inferChat` createRequest tx | reverts | Release action key (no LLM cost charged). Return `infer-failed`. |
| `inferChat` timeout (>waitMs, no ChatResultReady) | LLM never responded | Action key **STAYS HELD**. commitStatus=`INFER_TIMEOUT`. Agent silent for this DAY. **Late ChatResultReady ignored** by checking elapsed time vs deadline. |
| `inferChat` returns empty/whitespace | `result.response.trim() == ""` | scrubOutcome=`EMPTY_RESPONSE`, msgKind=`SKIP_SCRUBBED`, scrubAllowed=false, commit goes through with empty `sanitizedTextHash`. |
| Scrubber matched (role leak) | regex fired | scrubOutcome=`BLOCKED_ROLE_LEAK`, msgKind=`SKIP_SCRUBBED`, scrubAllowed=false, commit goes through with empty `sanitizedTextHash`, no WS broadcast. |
| **F3 phase recheck before commit** | `chain.getRoom(roomId).phase != PHASE_DAY` | commitStatus=`PHASE_ADVANCED`. **No commit tx sent.** No WS. Action key released (LLM cost already incurred, but skipping commit is correct). |
| `commitAgentMessageV2` tx reverts (any reason) | `waitForReceiptOrRevert` (chain-ops.ts:45) throws a generic `"${label} reverted on chain"` — revert reason / custom error data is **not** surfaced at handler level. **F-new-round4-1 reason-agnostic recovery:** on any commit failure, immediately read `chain.getAgentMessageHash(roomId, phaseId, agent)` and branch on stored value: **stored == our messageHash** → idempotent success: `commitStatus=COMMITTED`, proceed with on-success side effects (chat/log/WS). **stored != 0 AND stored != ours** → `commitStatus=COMMIT_CONFLICT`, action key STAYS HELD, NO chat/ledger/suspicion/WS mutations — our local text is not what landed on chain. **stored == 0** → `commitStatus=COMMIT_FAILED` (true failure, not dedup), action key STAYS HELD, no state mutations. Log raw revert error for debug, but never branch on its text. |
| Sponsor top-up tx fail (first attempt) | gas underpriced | 1 retry with 2x gasPrice (existing sponsor.ts pattern). If second fails → skip agent, commitStatus=`SPONSOR_LOW`. |
| WS broadcast fail (after commit) | client disconnected | Commit is canonical. FE recovers via `AgentMessageCommittedV2` event subscription + Redis chat log pull. Log warn, no retry. |

### Order of writes (atomicity)

```
1. Persist trace { commitStatus: "PENDING_INFERENCE" }
2. Send inferChat createRequest tx → wait ChatResultReady (or timeout)
3. Scrub raw response → decide scrubOutcome (ALLOWED | BLOCKED_ROLE_LEAK | EMPTY_RESPONSE)
   msgKind = (scrubOutcome === "ALLOWED") ? "MSG" : "SKIP_SCRUBBED"
4. Compute hashes (independent of phase): salt, rawResponseHash, promptHash, sanitizedTextHash, messageHash
5. F3 + F-new-4: re-check chain.getRoom(roomId).phase == PHASE_DAY
   if not → persist trace { commitStatus="PHASE_ADVANCED", msgKind, hashes — for debug }; return; no tx, no broadcast
6. Persist trace { commitStatus: "PENDING_COMMIT", msgKind, scrubOutcome, all F2 provenance fields }
7. Send commitAgentMessageV2(roomId, phaseId, messageHash) tx
8. waitForReceiptOrRevert
9. If success:
     a. Update trace { commitStatus: "COMMITTED", commitTxHash }   // msgKind / scrubOutcome preserved
     b. Set agentMessageCommittedKey Redis flag (cache for fast retries)
     c. If msgKind == "MSG":
        - rpush agentChatPromptKey + LTRIM 20
        - rpush agentChatLogKey
        - WS broadcast { type: "agent-chat", by, text, persona, day,
                         messageHash, commitTxHash }
          (F-new-2: somniaRequestId / promptHash / rawResponseHash STAY private in Redis
           until GameEnded — they appear on chain as RequestCreated.payload and would
           leak prompt/role mid-game per [[agent-role-secrecy]])
     d. (F6 v1: NO chat-event extraction into ledger / suspicion)
   If revert (F-new-round4-1 reason-agnostic recovery — `waitForReceiptOrRevert`
   throws generic "reverted on chain" without revert data; do not branch on error text):
     a. stored := chain.getAgentMessageHash(roomId, phaseId, agent)
     b. If stored == messageHash → idempotent self-retry: go to step 9 success path
     c. Else if stored != 0 → Update trace { commitStatus: "COMMIT_CONFLICT" };
        no Redis mutation; no WS; action key STAYS HELD; log local hash vs stored hash for forensics
     d. Else (stored == 0) → Update trace { commitStatus: "COMMIT_FAILED" };
        no state mutations; action key STAYS HELD; log raw revert error for debug
        (covers ZeroMessageHash impossibility-assert, NotAgent, paused, etc — all the same handler response)
```

### Phase boundary (F3)

Two-stage phase guard:
- **Pre-inference** (at top of each agent iteration): `chain.getRoom(roomId).phase == PHASE_DAY`. If advanced → emit `phase-ended-mid-round` log + skip remaining agents in queue.
- **Post-inference, pre-commit (F3)**: same check repeated immediately before `commitAgentMessageV2`. If advanced during the LLM wait → commitStatus=`PHASE_ADVANCED`, no tx, no broadcast.

After all agents processed: emit `DAY_ROUND_DONE` event on bus.

### Concurrent DAY_STARTED dedup

Covered by action key per `(chainId, roomId, phaseId, agent, "day-chat")`. Two
listener instances claiming same key → only one wins.

## Section 4 — Testing strategy

### Unit tests (vitest, in-process, mock chainOps + Redis)

| File | Coverage |
|---|---|
| `scrubber.test.ts` | Blocklist hits → `outcome:"BLOCKED_ROLE_LEAK"`: "I am the detective", "as the mafia...", "my role is doctor". False positives → `outcome:"ALLOWED"`: "doctor of math", "the detective story", "mafia movies are fun". Empty/whitespace input → `outcome:"EMPTY_RESPONSE"`. Returns `{outcome, matches, sanitized, scrubVersion}`. Derived `scrubAllowed = outcome === "ALLOWED"` matches what `computeMessageHash` binds. Verify `SCRUB_VERSION` constant exported and present in result. |
| `personas.test.ts` | Deterministic snapshot on fixed EOAs. All 10 personas reachable in 1000-EOA sample. Distribution sanity check **50–150 per persona** (loose to avoid flake). |
| `suspicion.test.ts` | Each v1 chain-only rule applied → expected delta. Cap `[0,1]`. Notes appended. **eventId idempotency**: replay same event → no double-count. Different eventIds → both apply. Explicitly test that `KILL` does NOT mutate suspicion vector (v1 rule). |
| `ledger.test.ts` | Append vote / kill / death events from chain sources. Read back consistent. Verify reserved fields (accusations / claims / defenses) remain empty in v1. Document v1 sequential-only constraint. |
| `day.test.ts` | DI all deps with fakes. Cases: happy path (all 4 commit, ledger/chat/WS updated 4×); **F4**: scrubber blocks 1 → 3 normal commits + 1 commit with `commitStatus=COMMITTED, msgKind=SKIP_SCRUBBED`, only 3 WS broadcasts; inferChat throws on 1 → `commitStatus=INFER_TIMEOUT`, action key held, others unaffected; **F3 phase-advanced-during-infer**: pre-check passes, inferChat returns after delay, recheck shows phase advanced → `commitStatus=PHASE_ADVANCED`, no commit tx, no WS, action key released; **F1 on-chain dedup hit**: `getAgentMessageHash` returns non-zero pre-check → `skipped-already-committed`, action key released; **F-new-round4-1 reason-agnostic recovery — commit fails AND stored == our hash** → success path proceeds (idempotent self-retry); **F-new-round4-1 — commit fails AND stored != 0 AND != ours** → `commitStatus=COMMIT_CONFLICT`, no WS, no chat mutation, action key held; **F-new-round4-1 — commit fails AND stored == 0** → `commitStatus=COMMIT_FAILED`, no state mutations, action key held; role miss → generic prompt, agent still commits; sponsor low → `commitStatus=SPONSOR_LOW`, structured reason persisted; phase advanced mid-round (pre-check) → remaining agents skip; replay DAY_STARTED → all `skipped-action-idempotent`; rotation: dayCount=0 vs 1 produces different speaker order; **F-new-2 WS payload contains only {by, text, persona, day, messageHash, commitTxHash} — never somniaRequestId / promptHash / rawResponseHash.** |
| `llm-chat-call.test.ts` | createRequest payload encoding correct; ChatResultReady subscription; getResult decoded as single string; **timeout → INFER_TIMEOUT**; **late ChatResultReady after timeout ignored** (state machine refuses transition out of terminal state). |
| `messageHash.test.ts` | **F2 provenance fields:** same inputs → same hash; changing any of `somniaRequestId / promptHash / rawResponseHash / sanitizedTextHash / scrubVersion / scrubAllowed` → different hash. **F1 phase binding:** different `phaseId` → different hash. Different `roomId / chainId / agent / msgKind` → different hash. Cross-check vs reference eth-abi implementation (snapshot a known hash). **F-new-1:** `computeMessageHash` over any non-empty material MUST NOT return `bytes32(0)` — assert against zero on every test case. |

Target: ~28 new tests. Full suite target 235+/235+ green (current 208).

### On-chain smoke

**`smoke-chat-result-store.mjs`** (run first, before DAY handler smoke):
1. Deploy `LLMChatResultStore` to testnet 50312.
2. Call `AgentRequester.createRequest(LLM_CHAT_AGENT_ID, store, handleResponse selector, "say hello in 5 words")`.
3. Wait `ChatResultReady` event.
4. Read `getResult(requestId)` → assert non-empty string.
5. Verify single-string decode round-trip (encode known string → decode → byte equality).

**AgentRegistryFacet V2 upgrade smoke** (run before DAY handler smoke):
1. Run `scripts/upgrade-agent-registry-v4.ts` against testnet diamond.
2. Probe `getAgentMessageHash(0, 0x0, 0x0)` → expect `0x000...`.
3. Probe `getAgentMessageHash` for a known committed phase on an existing test agent → expect `0x000...` (storage is fresh — no prior writes).
4. Manually call `commitAgentMessageV2(roomId, phaseId, fakeMessageHash)` from a registered agent via test wallet. Verify event emitted with all three indexed fields and storage updated.
5. Second call with same `(roomId, phaseId)` → expect revert `MessageAlreadyCommitted`.
6. **F-new-1 (round-3) + F-new-round4-2 corrected expectation:** call `commitAgentMessageV2(roomId, phaseId, bytes32(0))` on a *fresh* slot → expect revert `ZeroMessageHash`. Verify storage stays unset. Subsequent non-zero `commitAgentMessageV2(roomId, phaseId, fakeHash1)` → **succeeds** (slot was never written). A second non-zero `commitAgentMessageV2(roomId, phaseId, fakeHash2)` → reverts with `MessageAlreadyCommitted`. This sequence proves that a zero-revert does not corrupt the dedup state.

**`smoke-day-chat.ts`** (full handler smoke):
1. Use existing room 8 with ≥1 active agent.
2. Manually trigger `DayHandler.handle(synthetic DAY_STARTED event)`.
3. Assert: 1 `AgentMessageCommittedV2` event per active agent on chain (with phaseId indexed).
4. Read Redis trace per agent → assert `commitStatus == "COMMITTED"`.
5. Compare on-chain `messageHash` from event to Redis-stored hash → match.
6. Recompute `messageHash` from stored material via `computeMessageHash(...)` → must match the on-chain emitted hash byte-for-byte (proves F2 binding).
7. Cross-check chain-getter: `getAgentMessageHash(roomId, phaseId, agent)` returns the same hash.
8. Spot-check 1 trace `sanitizedText` → re-hash via `messageTextHash` → equals stored `sanitizedTextHash`.

**Controlled scrubber smoke (optional, can be unit-only):** force LLM
response with role-leak string via test fixture → assert
`AgentMessageCommittedV2` exists, **no WS broadcast**, Redis trace
`commitStatus == "COMMITTED"` AND `msgKind == "SKIP_SCRUBBED"` AND
`sanitizedTextHash == ZERO_BYTES32`.

### Deferred to 4i
- Full DAY → VOTING → NIGHT E2E
- Restart resilience / listener backfill
- Redis cold restart mid-DAY

## Section 5 — Rollout / env / risks

### Env vars (`.env.example`)

```bash
# DAY chat — DISABLED by default. Flip to true only in local for smoke.
AGENTS_DAY_ENABLED=false

# Somnia inferChat result store (one address per chainId).
# Boot validation crashes if AGENTS_DAY_ENABLED=true and the env for the active chainId is unset.
# Testnet (50312):
LLM_CHAT_STORE_50312=
# Mainnet (5031):
LLM_CHAT_STORE_5031=

# Inference + commit tuning
LLM_CHAT_AGENT_ID=12847293847561029384   # same Somnia agentId as inferString — verify on first call
# F5: chat replies typically arrive in 3.8-5.8s (observed inferString / inferToolsChat latency).
# 25s wait is generous-but-realistic; 4 agents × 28s + tx budget + 10s buffer ≈ 122s phase requirement.
LLM_CHAT_WAIT_MS=25000
LLM_CHAT_GAS_PRICE_GWEI=10
TX_GAS_PRICE_GWEI=10
AGENTS_DAY_LANGUAGE=English

# Scrubber mode: strict | lenient. "disabled" allowed only if NODE_ENV=local.
SCRUBBER_MODE=strict

# Sponsor safety: skip agent if sponsor balance below this (in STT).
# Default 1.5 STT covers 4 agents × (0.24 inferChat + 0.1 commit gas) + buffer.
SPONSOR_LOW_THRESHOLD_STT=1.5
```

### Boot validation

On gm-server boot:
- If `AGENTS_DAY_ENABLED=true` and `LLM_CHAT_STORE_${chainId}` is empty for any active chain → crash with explicit error.
- If `SCRUBBER_MODE=disabled` and `NODE_ENV != "local"` → crash with explicit error.

### Rollout order

1. Deploy `LLMChatResultStore` on testnet 50312 → save addr.
2. Run `smoke-chat-result-store.mjs` standalone. Confirm decode + event.
3. Merge gm-server code with `AGENTS_DAY_ENABLED=false` default in `.env.example`.
4. Local `.env`: set `AGENTS_DAY_ENABLED=true` + store addr → run `smoke-day-chat.ts` on room 8.
5. Promote to dev server (CI/CD push). Set `AGENTS_DAY_ENABLED=true` only after manual approval.
6. Mainnet: deploy store, set `LLM_CHAT_STORE_5031`, flip flag last (after E2E in 4i).

### Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| LLM emits role-revealing text uncaught by regex | Medium | Pre-prompt + regex + extendable blocklist post-incident. All scrubber matches logged for tuning. |
| Sponsor drain mid-game | Low | Hard guard via `SPONSOR_LOW_THRESHOLD_STT`. Skips agent cleanly. |
| `inferChat` agentId differs from inferString | Low | Probe in `smoke-chat-result-store.mjs`. Log warning if mismatch. |
| DAY phase too short for full round-robin (F5) | Medium | **Preflight rule:** `minPhaseSec = agents × ((LLM_CHAT_WAIT_MS / 1000) + commitTxBudgetSec) + buffer`. With `LLM_CHAT_WAIT_MS=25000`: 4 agents × 28s + 10s = **122s minimum**. Recommend `DAY_PHASE_SECONDS ≥ 150` for demo to leave margin. Handler logs warning if observed phase shorter than computed minimum AND aborts remaining queue cleanly (`PHASE_ADVANCED` per agent). |
| **F3 phase advances during inferChat wait** | Medium | Two-stage phase check — pre-inference + post-inference pre-commit. Latter aborts with `commitStatus=PHASE_ADVANCED`, no commit tx, no broadcast. Tested in `day.test.ts`. |
| **F1 listener crash between commit tx and Redis flag** | Low | V2 contract has on-chain dedup storage — restart resilience does **not** require Redis flag. Listener startup can call `getAgentMessageHash(roomId, phaseId, agent)` to learn truth. Redis flag is fast-path optimisation only. |
| `AGENTS_DAY_ENABLED=true` on mainnet with store unset | Medium | Boot validation crash. |
| Persona pool 10 collisions (2 agents same persona) | Low | Acceptable v1 (slight aesthetic dup). Expand to 20 if observed in demo. |
| Late `ChatResultReady` after INFER_TIMEOUT | Low | Wrapper drops events past deadline; state machine refuses transition out of INFER_TIMEOUT. Tested. |
| WS broadcast race (msg shown before chain confirms) | Low | FE concern (Days 10-12). Out of 4d scope. |

### Pre-flight checklist (before merging 4d)

- [ ] **F1: AgentRegistryFacet V4 upgrade deployed on testnet** (`commitAgentMessageV2` + `getAgentMessageHash` + `AgentMessageCommittedV2` + dedup revert). Probed: zero state + double-commit reverts.
- [ ] `LLMChatResultStore` deployed on testnet; addr in `LLM_CHAT_STORE_50312`
- [ ] `smoke-chat-result-store.mjs` passes (event arrives, getResult returns non-empty string)
- [ ] Full unit suite green; target 235+/235+
- [ ] `smoke-day-chat.ts` passes on testnet room 8 — including hash-recompute step (proves F2 binding)
- [ ] Sponsor balance ≥3 STT before merge (≥10 active demos worth)
- [ ] `.env.example` shipped with `AGENTS_DAY_ENABLED=false` + chain-labeled comments + `LLM_CHAT_WAIT_MS=25000`
- [ ] Boot validation tested locally for misconfig paths
- [ ] Scrubber match log reviewed on smoke output (no role leaks reached chain)
- [ ] **F3: timing test** — induced 30s LLM delay → handler emits `PHASE_ADVANCED` cleanly without committing

## See also

- [[task-4f-night-done]] — pattern reference (handler lifecycle, idempotency, ECIES role lookup)
- [[task-4b-voting-done]] — pattern reference (chain-ops DI, sponsor flow)
- [[4e-tools-smoke-done]] — inferToolsChat result store deploy + smoke methodology
- [[somnia-llm-inference]] — `inferChat` primitive spec, cost, agentId
- [[agent-role-secrecy]] — why mid-game trace material stays private; only `COMMITTED`/`SCRUBBED_SKIP` revealable
- [[never-hardcode-pk]] — all keys via env, never inline
- [[always-verify-code]] — code review discipline that caught design issues in this brainstorm
- [[audit-stats-plan]] — post-game audit consumer of revealed traces (Days 13-15)
- [[agentathon-master-plan]] — 22-day schedule, 4d sits at Day 6

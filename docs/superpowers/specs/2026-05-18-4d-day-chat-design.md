# Task 4d — DAY chat design

**Status:** approved 2026-05-18 (brainstorming phase). Implementation plan TBD.

**Scope:** Implement the DAY phase chat handler for SomniaMafia agents. Each
agent generates one in-character message per DAY phase via Somnia's on-chain
`inferChat` primitive. Messages are role-scrubbed, committed on chain via
`commitAgentMessage`, broadcast over WebSocket, and persisted to Redis for
per-agent memory.

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
| 4 | Memory: event-pinned ledger + per-agent suspicion/trust vector + last 20 chat msgs | Zero extra LLM cost for memory. Captures cross-day contradictions via structured events. Vector adds personality / "stance" to agents without freeform memory bloat. |
| 5 | Suspicion vector updates via deterministic heuristic rules | Zero LLM cost, debuggable, jury-explainable. |
| 6 | Persona: EOA-deterministic from hardcoded pool of 10, pinned at fill-room time | Wallet-bound identity, reproducible, no extra inference cost. |
| 7 | Trace state machine (`PENDING_INFERENCE`/`PENDING_COMMIT`/`COMMITTED`/`COMMIT_FAILED`/`INFER_TIMEOUT`/`SCRUBBED_SKIP`) | Only `COMMITTED` and `SCRUBBED_SKIP` are post-game revealable. Unconfirmed traces never leak. |
| 8 | inferChat timeout → keep action key held, agent silent for that DAY | Divergence from NIGHT (which releases on throw). Rationale: DAY chat silence is non-game-breaking; preventing duplicate cost / phantom commits is higher value. |
| 9 | Role load miss → generic neutral prompt, not CITIZEN fallback | Safer: cannot accidentally tell LLM it is a citizen when role storage is broken. |
| 10 | Sponsor budget guard skips inference if balance below threshold | Protects against single-game sponsor drain. Skip logged with structured reason. |

## Section 1 — Architecture

### Handler lifecycle (mirror NIGHT pattern)

```
DAY_STARTED event (chain listener → AgentEventBus)
  → DayHandler.handle(event)
    → enumerate agents (chain.getPlayers + isAgent)
    → match to HD-derived wallets (matchWalletsToAgents)
    → compute rotating round-robin order: agentsSorted with offset = dayCount % len
    → for each agent in order:
        check phase still DAY (chain.getRoom) — abort if advanced
        claim agents:action:{chainId}:{roomId}:{phaseId}:{agent}:day-chat (NX, EX=24h)
        if claim fails → skipped-action-idempotent
        load role, persona, ledger, suspicion, last 20 chat, alivePlayers
        check sponsor balance → if low, skip with sponsor-low-no-inference status
        persist PENDING_INFERENCE trace
        build prompt (system + persona + role-aware lines OR neutral if role missing)
        call llm-chat-call.inferChatOnSomnia (uses LLMChatResultStore)
        if timeout: status=INFER_TIMEOUT, action key STAYS HELD, return
        if response empty/null: route as scrubbed-empty
        scrub(rawText):
          if matches blocklist: scrubResult = {allowed:false, reason, matches, sanitized:null}
          else: scrubResult = {allowed:true, sanitized:trim(text)}
        if !allowed:
          status=SCRUBBED_SKIP
          msgKind = keccak("SKIP_SCRUBBED")
          textHash = ZERO_BYTES32
          (no WS broadcast)
        else:
          msgKind = keccak("MSG")
          textHash = messageTextHash(sanitized)
        salt = randomSalt()
        messageHash = keccak(domain-separated tuple — see Section 2)
        persist PENDING_COMMIT trace
        send commitAgentMessage(roomId, messageHash) from agent EOA
        waitForReceiptOrRevert
        on success:
          status=COMMITTED
          if MSG path:
            redis.rpush(agentChatPromptKey) + LTRIM last 20
            redis.rpush(agentChatLogKey)
            append claim/accusation/defense to ledger
            update suspicion vectors of OTHER agents via heuristic rules
            wsManager.broadcastToRoom(... {type:"agent-chat", by, text, persona, day})
          on commit revert:
            status=COMMIT_FAILED
            action key STAYS HELD (do not retry doomed agent)
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
gm-server/src/agents/registry-abi.ts   edit + commitAgentMessage write fn + AgentMessageCommitted event
gm-server/src/agents/redis-keys.ts     edit + agentChatPromptKey, agentChatLogKey, agentLedgerKey,
                                            agentSuspicionKey, agentPersonaKey,
                                            agentSuspicionProcessedKey, agentSkipReasonKey,
                                            extend agentActionProcessedKey "day-chat" tag
gm-server/src/agents/trace.ts          edit + AGENT_MESSAGE_TYPEHASH + computeMessageHash + messageTextHash
                                            + TraceStatus union + helpers to read/write status
gm-server/src/scripts/smoke-chat-result-store.mjs  new  standalone LLM smoke
gm-server/src/scripts/smoke-day-chat.ts            new  full DAY handler smoke
gm-server/test/agents/day.test.ts                  new  ~22 handler tests
gm-server/test/agents/scrubber.test.ts             new
gm-server/test/agents/personas.test.ts             new
gm-server/test/agents/suspicion.test.ts            new
gm-server/test/agents/ledger.test.ts               new
gm-server/test/agents/llm-chat-call.test.ts        new
gm-server/test/agents/messageHash.test.ts          new

SomniaSol/contracts/LLMChatResultStore.sol         new  single-string result store + PLATFORM guard
SomniaSol/scripts/deploy-llm-chat-store.ts         new  testnet + mainnet
SomniaSol/test/LLMChatResultStore.ts               new  unit tests for handleResponse decode + guard
```

### Reuse from existing 4b/4f/4g

- `chain-ops.ts` send-pattern (sponsor top-up → tx → receipt verify) — replicate for
  `sendCommitMessage(agent, roomId, messageHash, gasPriceGwei)`.
- `sponsor.ts` top-up flow.
- `wallets.ts` HD derivation + `matchWalletsToAgents`.
- `trace.ts` `randomSalt`, `makePhaseId("DAY", dayCount)`.
- `roles.ts` `getAgentRole`.
- DI / idempotency 3-layer (action key + active check + on-chain existing-commit check).
  Note: DAY uses a separate flag — there is no on-chain trace storage for messages
  (only event emit), so the "existing commit" check reads
  `agentMessageCommittedKey(chainId, roomId, phaseId, agent)` Redis flag set on commit success.

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

### Canonical text/message hashing helpers (`trace.ts`)

```typescript
export const AGENT_MESSAGE_TYPEHASH = keccak256(toHex("MAFIA_AGENT_MESSAGE_V1"));

export function messageTextHash(text: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }], [text])
  );
}

export function computeMessageHash(m: {
  chainId: bigint; diamond: Hex; roomId: bigint; phaseId: Hex;
  agent: Hex; salt: Hex; textHash: Hex; msgKind: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, address, uint256, bytes32, address, bytes32, bytes32, bytes32"
      ),
      [AGENT_MESSAGE_TYPEHASH, m.chainId, m.diamond, m.roomId, m.phaseId,
       m.agent, m.salt, m.textHash, m.msgKind]
    )
  );
}

export const MSG_KIND_REGULAR = keccak256(toHex("MSG"));
export const MSG_KIND_SKIP_SCRUBBED = keccak256(toHex("SKIP_SCRUBBED"));
```

### TraceStatus union (`trace.ts`)

```typescript
export type TraceStatus =
  | "PENDING_INFERENCE"
  | "PENDING_COMMIT"
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "INFER_TIMEOUT"
  | "SCRUBBED_SKIP";
```

Only `COMMITTED` and `SCRUBBED_SKIP` are revealable post-game. Reveal endpoint
(future) filters by status.

### Suspicion event idempotency

```typescript
type SuspicionEvent = {
  eventId: string;  // stable: `${txHash}-${logIndex}` or `chat-${commitTxHash}` etc
  kind: "VOTE" | "KILL" | "ACCUSATION" | "DEFENSE" | "ROLE_CLAIM";
  // ...payload
};

async function applySuspicionEvent(state, event, redis, ...keys) {
  const isMember = await redis.sismember(agentSuspicionProcessedKey, event.eventId);
  if (isMember) return state;
  await redis.sadd(agentSuspicionProcessedKey, event.eventId);
  await redis.expire(agentSuspicionProcessedKey, 24*3600);
  // apply heuristic mutation, return new state
}
```

Event ID sources:
- VOTE chain events: `${txHash}-${logIndex}`
- KILL (NightEnded reveal): `night-${roomId}-${dayCount}`
- ACCUSATION / DEFENSE / ROLE_CLAIM (from chat ledger): `chat-${commitTxHash}` (stable post-commit)

### Heuristic rules (`suspicion.ts`)

```
VOTE event (from chain), voter X → target Y:
  for all agents A (A != X):
    if A.priorAccusedBy(Y) within last 2 days:
      A.suspicion[X] += 0.10
      A.notes.push("Day N: X voted for Y who had accused A")

KILL event (night death revealed), victim V:
  for all alive agents A:
    last_accuser_of_V = ledger.lookupLastAccuserOf(V, within day N-1)
    if last_accuser_of_V exists:
      A.suspicion[last_accuser_of_V] += 0.05  // weak signal
      A.notes.push("Day N: previously accused night victim V; weak signal")

ACCUSATION event (chat ledger), accuser X → target Y:
  Y.suspicion[X] += 0.15
  Y.notes.push("Day N: X accused me")
  for all other A:
    A.suspicion[X] += 0.05

DEFENSE event (chat ledger), defender X → defended Y:
  Y.trust[X] += 0.10
  Y.notes.push("Day N: X defended me")

ROLE_CLAIM event (chat ledger), claimer X claims role R publicly:
  for all alive A:
    A.suspicion[X] += 0.05  // drew attention, neutral mild
    A.notes.push("Day N: X publicly claimed " + R)
```

Cap all scores at `[0, 1]`. Notes truncated to last 20.

### Ledger growth notes

For v1, DayHandler runs sequentially per room → ledger mutation race not possible
in-instance. For multi-instance prod (out of 4d scope), ledger updates must use
Redis WATCH/MULTI or Lua script. Documented in handler comment.

KILL heuristic is intentionally weak (`+0.05`) because mafia commonly targets
threats but may also misdirect. Note prefix `weak signal:` makes provenance
explicit in audit.

## Section 3 — Error handling

### Trace state transitions

```
On infer dispatch:                       status = PENDING_INFERENCE
On infer success, scrub allowed:         status = PENDING_COMMIT
On commit success:                       status = COMMITTED
On commit revert (post-tx-sent):         status = COMMIT_FAILED, action key STAYS HELD
On infer timeout (no result in waitMs):  status = INFER_TIMEOUT, action key STAYS HELD
On scrub blocked / response empty:       status = SCRUBBED_SKIP, commit goes through with empty textHash
```

### Failure response table

| Stage | Failure | Response |
|---|---|---|
| Action key claim | already held | Skip — `skipped-action-idempotent`. Other run handles. |
| Role load Redis miss | role missing | **Generic neutral prompt, NOT citizen.** System prompt explicit: "You don't know your role; speak only generic social observations." Continue normally. |
| Sponsor balance check | `< SPONSOR_LOW_THRESHOLD_STT` | Skip; persist `agentSkipReasonKey = "sponsor-low-no-inference"`. No inference, no commit. |
| `inferChat` createRequest tx | reverts | Release action key (no LLM cost charged). Return `infer-failed`. |
| `inferChat` timeout (>waitMs, no ChatResultReady) | LLM never responded | Action key **STAYS HELD**. Trace `INFER_TIMEOUT`. Agent silent for this DAY. **Late ChatResultReady ignored** by checking elapsed time vs deadline. |
| `inferChat` returns empty/whitespace | `result.response.trim() == ""` | Route to scrubbed-empty: status=SCRUBBED_SKIP, commit empty textHash. |
| Scrubber matched (role leak) | regex fired | status=SCRUBBED_SKIP, commit empty textHash, no WS broadcast, ledger note "scrubber-blocked". |
| `commitAgentMessage` tx reverts | `waitForReceiptOrRevert` throws | Trace already PENDING_COMMIT — update to COMMIT_FAILED. **Action key NOT released.** No Redis chat / ledger / suspicion mutations. No WS broadcast. |
| Sponsor top-up tx fail (first attempt) | gas underpriced | 1 retry with 2x gasPrice (existing sponsor.ts pattern). If second fails → skip agent, status=sponsor-low-no-inference. |
| WS broadcast fail (after commit) | client disconnected | Commit is canonical. FE recovers via `AgentMessageCommitted` event subscription + Redis chat log pull. Log warn, no retry. |

### Order of writes (atomicity)

```
1. Persist PENDING_INFERENCE trace
2. Send inferChat createRequest tx → wait ChatResultReady
3. Scrub
4. Persist PENDING_COMMIT trace (with prompt, salt, textHash, msgKind)
5. Send commitAgentMessage tx
6. waitForReceiptOrRevert
7. If success:
     a. Update trace status = COMMITTED, append commitTxHash
     b. Set agentMessageCommittedKey flag
     c. (MSG path only) rpush agentChatPromptKey + LTRIM 20
     d. (MSG path only) rpush agentChatLogKey
     e. (MSG path only) append claim to ledger
     f. (MSG path only) apply suspicion event to all other agents
     g. (MSG path only) WS broadcast
   If revert:
     a. Update trace status = COMMIT_FAILED
     b. NO state mutations (chat, ledger, suspicion, WS untouched)
     c. action key STAYS HELD
```

### Phase boundary

- At top of each agent iteration: re-check `chain.getRoom(roomId).phase == PHASE_DAY`.
  If advanced → emit `phase-ended-mid-round` log + skip remaining agents.
- After all agents processed: emit `DAY_ROUND_DONE` event on bus.

### Concurrent DAY_STARTED dedup

Covered by action key per `(chainId, roomId, phaseId, agent, "day-chat")`. Two
listener instances claiming same key → only one wins.

## Section 4 — Testing strategy

### Unit tests (vitest, in-process, mock chainOps + Redis)

| File | Coverage |
|---|---|
| `scrubber.test.ts` | Blocklist hits: "I am the detective", "as the mafia...", "my role is doctor". False positives: "doctor of math", "the detective story", "mafia movies are fun". Returns `{allowed, reason:"ROLE_LEAK", matches, sanitized}`. |
| `personas.test.ts` | Deterministic snapshot on fixed EOAs. All 10 personas reachable in 1000-EOA sample. Distribution sanity check **50–150 per persona** (loose to avoid flake). |
| `suspicion.test.ts` | Each rule applied → expected delta. Cap `[0,1]`. Notes appended. **eventId idempotency**: replay same event → no double-count. Different eventIds → both apply. |
| `ledger.test.ts` | Append vote/kill/accusation/claim/defense. Read back consistent. Document v1 sequential-only constraint. |
| `day.test.ts` | DI all deps with fakes. Cases: happy path (all 4 commit, ledger/chat/WS updated 4×); scrubber blocks 1 → 3 commits + 1 SCRUBBED_SKIP, 3 WS broadcasts; inferChat throws on 1 → INFER_TIMEOUT, action key held, others unaffected; **commit revert → trace=COMMIT_FAILED, no Redis chat/ledger/suspicion mutation, no WS**; role miss → generic prompt, agent still commits; sponsor low → skipped with structured reason; phase advanced mid-round → remaining agents skip; replay DAY_STARTED → all `skipped-action-idempotent`; rotation: dayCount=0 vs 1 produces different speaker order. |
| `llm-chat-call.test.ts` | createRequest payload encoding correct; ChatResultReady subscription; getResult decoded as single string; **timeout → status INFER_TIMEOUT**; **late ChatResultReady after timeout ignored**. |
| `messageHash.test.ts` | Same inputs → same hash. Different roomId → different hash. Different chainId → different hash. Different agent → different hash. Different msgKind (MSG vs SKIP_SCRUBBED) → different hash. Cross-check vs reference eth-abi implementation. |

Target: ~25 new tests. Full suite target 230+/230+ green (current 208).

### On-chain smoke

**`smoke-chat-result-store.mjs`** (run first, before DAY handler smoke):
1. Deploy `LLMChatResultStore` to testnet 50312.
2. Call `AgentRequester.createRequest(LLM_CHAT_AGENT_ID, store, handleResponse selector, "say hello in 5 words")`.
3. Wait `ChatResultReady` event.
4. Read `getResult(requestId)` → assert non-empty string.

**`smoke-day-chat.ts`** (full handler smoke):
1. Use existing room 8 with ≥1 active agent.
2. Manually trigger `DayHandler.handle(synthetic DAY_STARTED event)`.
3. Assert: 1 `AgentMessageCommitted` event per active agent on chain.
4. Read Redis trace per agent → assert `status == COMMITTED`.
5. Compare on-chain messageHash to Redis-stored hash → match.
6. Spot-check 1 trace text → re-hash → equals stored textHash.

**Controlled scrubber smoke (optional, can be unit-only):** force LLM
response with role-leak string via test fixture → assert
`AgentMessageCommitted` exists, **no WS broadcast**, Redis trace
`status == SCRUBBED_SKIP`.

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
LLM_CHAT_WAIT_MS=60000
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
| DAY phase too short for full round-robin | Medium | **Preflight rule:** `minPhaseSec = agents × ((LLM_CHAT_WAIT_MS / 1000) + commitTxBudgetSec) + buffer`. Recommend `DAY_PHASE_SECONDS ≥ 90` for demo. Handler logs warning when observed phase shorter than computed minimum. |
| `AGENTS_DAY_ENABLED=true` on mainnet with store unset | Medium | Boot validation crash. |
| Persona pool 10 collisions (2 agents same persona) | Low | Acceptable v1 (slight aesthetic dup). Expand to 20 if observed in demo. |
| Late `ChatResultReady` after INFER_TIMEOUT | Low | Wrapper drops events past deadline; state machine refuses transition out of INFER_TIMEOUT. Tested. |
| WS broadcast race (msg shown before chain confirms) | Low | FE concern (Days 10-12). Out of 4d scope. |

### Pre-flight checklist (before merging 4d)

- [ ] `LLMChatResultStore` deployed on testnet; addr in `LLM_CHAT_STORE_50312`
- [ ] `smoke-chat-result-store.mjs` passes (event arrives, getResult returns non-empty string)
- [ ] Full unit suite green; target 230+/230+
- [ ] `smoke-day-chat.ts` passes on testnet room 8
- [ ] Sponsor balance ≥3 STT before merge (≥10 active demos worth)
- [ ] `.env.example` shipped with `AGENTS_DAY_ENABLED=false` + chain-labeled comments
- [ ] Boot validation tested locally for misconfig paths
- [ ] Scrubber match log reviewed on smoke output (no role leaks reached chain)

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

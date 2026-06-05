# Post-Game Agent Trace Reveal Driver — Design

> Date: 2026-06-05 · Repo: `somnia-mafia-gm-server` · Author: Haiman (Renat Khaimanov)
> Status: approved design, pre-implementation

## Problem

The contract function `revealAgentInferenceTrace(...)` is deployed (AgentRegistryFacet v4)
and the gm-server already persists every inference trace to Redis at commit time, but
**nothing ever calls the reveal function**. So `AgentInferenceRevealed` is never emitted,
and the frontend `AgentReport.tsx` shows every agent action as grey "committed" instead of
green "verified". This is the single gap behind the deck's "full post-game reasoning-trace
reveal is in development" line. Closing it turns an honest hedge into a shipped, on-chain-
provable feature with **zero frontend work** (the report already reads the reveal events).

## What already exists (do not rebuild)

| Piece | Location | Status |
|---|---|---|
| `revealAgentInferenceTrace(roomId, phaseId, agent, somniaRequestId, promptHash, responseHash, actionHash, salt)` | `SomniaSol/contracts/facets/AgentRegistryFacet.sol:179` | ✅ deployed v4. **GM-only** (`msg.sender == ds.gameMaster`), reverts unless room phase `== ENDED`. Verifies stored commitment == recomputed, emits `AgentInferenceRevealed`. No double-reveal guard (re-reveal is harmless: re-verify + re-emit). |
| Trace persistence | `agents/night.ts`, `agents/day.ts`, voting | ✅ writes Redis blob at commit time |
| Redis key | `agentTraceKey(chainId, roomId, phaseId, agent)` = `agents:trace:{chainId}:{roomId}:{phaseLabel}:{agent}` | ✅ value JSON `{salt, somniaRequestId, promptHash, responseHash, actionHash, traceCommitment, prompt, response, target, ...}`, **TTL 7 days** (`IDEMPOTENCY_TTL_SECONDS`). ⚠️ `somniaRequestId` is stored as a **string** ("0" / decimal). |

### ⚠️ phaseId has two representations (verified in code)

This is the load-bearing subtlety. There is **no single phaseId**:

- **On-chain / commitment:** `phaseIdHex = makePhaseId(kind, day) = keccak256(toHex("D{day}-{KIND}"))` (`agents/trace.ts:48`). `commitAgentInference` stores under this keccak, and `AgentInferenceCommitted.phaseId` (and the reveal's `phaseId` arg + the contract's `computeTraceCommitment`) all use this **bytes32 keccak**.
- **Redis trace key:** built with `event.phaseId`, which `agents/events.ts:127` defines as the **semantic label string** `"D{day}-NIGHT"` (likewise `-DAY`, `-VOTING`) — **not** the keccak.

So enumerating commits gives keccak phaseIds, but the trace blob is stored under the label. The driver MUST bridge them with a reverse map `keccak → label`, precomputed via `makePhaseId(kind, day)` over `day ∈ 1..dayCount × kind ∈ {DAY, VOTING, NIGHT}` — exactly the `makePhaseLookup` pattern already in `AgentReport.tsx`. The reveal call passes the **keccak** phaseId; the Redis GET uses the **label**.
| ABI binding | `agents/registry-abi.ts` | ⚠️ selector `0x7c9fbbc0` is only listed in a **doc comment** (line 17). The `revealAgentInferenceTrace` function and `AgentInferenceRevealed` event are **NOT** in the `AGENT_REGISTRY_ABI` `parseAbi` array — they must be added before the function is callable. |
| Frontend "committed → verified" badge | `SomniaMafia/components/game/AgentReport.tsx:31-33,177-184,215,637-639` | ✅ reads `AgentInferenceRevealed`, flips badge automatically. No change needed. |

## Scope

Build the missing post-game driver that enumerates each committed inference slot for a
room and calls the deployed `revealAgentInferenceTrace` from the GM wallet. Triggered both
automatically (on game ENDED) and manually (operator endpoint). No contract changes, no
frontend changes.

**Out of scope (YAGNI):** revealing message commits (`AgentMessageCommittedV2` — chat, not
inference, the report keeps those as "committed"); exposing raw prompts/responses anywhere
(the UI deliberately keeps them hidden); retroactive reveal of rooms whose traces have
expired past the 7-day TTL.

## Architecture

### Core service (shared) — `src/agents/reveal-trace.ts`

`revealRoomTraces({ chainId, roomId, deps }): Promise<RevealReport>`

Mirrors the `revealRoles.ts` pattern (one core consumed by both an endpoint and an
automatic finalizer). Enumeration source of truth is **on-chain commit events**, not a
Redis SCAN — so reveal binds 1:1 to what was actually committed and never depends on the
Redis key layout.

Steps:
1. **Guard.** Read room phase on-chain (`getRoom`). If `!= ENDED`, return early with a clear
   `room-not-ended` error (the contract enforces this too; we fail fast for a clean message).
   Read `dayCount` here too — it bounds the phaseId reverse map.
2. **Build phaseId reverse map.** For `day ∈ 1..dayCount × kind ∈ {DAY, VOTING, NIGHT}`,
   compute `makePhaseId(kind, day)` → map `keccak → label "D{day}-{KIND}"`.
3. **Enumerate committed slots.** `getLogs(AgentInferenceCommitted, {roomId})` in 900-block
   chunks (same chunking as `AgentReport.tsx`) → `slots: {phaseIdHex, agent, actionHash}[]`
   (`phaseIdHex` = the bytes32 keccak from the log).
4. **Load already-revealed.** `getLogs(AgentInferenceRevealed, {roomId})` →
   `revealedKeys: Set<"agent:phaseIdHex:actionHash">`. Skip any slot already in the set
   (idempotency — avoids duplicate events and wasted gas).
5. **Per un-revealed slot:**
   a. `label = reverseMap[phaseIdHex]`. Not found → `skip("unknown-phase")` (a committed
      phaseId outside DAY/VOTING/NIGHT — shouldn't happen, but never crash on it).
   b. GET trace `agentTraceKey(chainId, roomId, label, agent)` (note: **label**, not keccak).
   c. Missing / expired → `skip("trace-expired")`, continue (one bad trace never aborts batch).
   d. JSON missing a required field (`salt`/`somniaRequestId`/`promptHash`/`responseHash`/
      `actionHash`) → `skip("trace-incomplete")`.
   e. Trace `actionHash` != on-chain committed `actionHash` → `skip("actionhash-mismatch")`.
   f. (Optional pre-flight) recompute `computeTraceCommitment` locally and compare to the
      on-chain stored commitment / the blob's `traceCommitment`; mismatch → `skip("commitment-mismatch")`
      to avoid a guaranteed `TraceMismatch` revert tx.
   g. Call `revealAgentInferenceTrace(roomId, phaseIdHex, agent, BigInt(somniaRequestId),
      promptHash, responseHash, actionHash, salt)` from the **GM wallet client**
      (`getChainConfig(chainId).wallet` — the same `gameMaster` EOA that signs
      `resolveNightAsGameMaster`; verified GM-only check passes). It already routes through
      the serialized client (nonce-safe after fix 0e800c5). Gas cap ~300k (light tx:
      keccak + event), bounded retry, `waitForReceiptOrRevert`.
   h. Record `revealed(txHash)` or `failed(reason)`.
6. Return `RevealReport { roomId, total, revealed: number, skipped: {slot,reason}[],
   failed: {slot,reason}[], txHashes: string[] }`.

Note the reveal call passes the **keccak** `phaseIdHex` (matches what the commitment was
computed and stored under); only the Redis GET uses the **label**. `somniaRequestId` is
coerced from its stored string to `BigInt`.

### Trigger A — automatic (on ENDED)

Hook into the existing game-ENDED handling (exact file located during writing-plans — the
path that observes `GameEnded` / the headless endgame finalizer). Fire-and-forget
`revealRoomTraces` so it never blocks the endgame response; log the `RevealReport`.
A Redis once-claim `agents:revealdone:{chainId}:{roomId}` (SET NX EX, pattern as
`agentHeadlessDayKey`) prevents a concurrent or re-delivered ENDED from double-running.
Re-delivery is also safe via the step-3 revealed-set skip.

### Trigger B — manual endpoint

`POST /agents/reveal-room { roomId, chainId? }` in `src/routes/agentRoutes.ts` (alongside
`/agents/fill-room`, behind the same `actionLimiter`). Calls the same core, returns the
`RevealReport` as JSON. Gives operator control, a re-run path if a reveal tx drops, and the
ability to reveal **room 72 right now** as a live demo proof.

## Data flow

```
GameEnded(roomId)                 POST /agents/reveal-room {roomId}
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
            revealRoomTraces({chainId, roomId})
                       │
        ┌──────────────┼───────────────────────────────┐
        ▼              ▼                                 ▼
 getLogs Committed  getLogs Revealed         keccak→label reverse map
  (keccak slots)    (skip-set)               (makePhaseId over days)
        └──────────────┴───────────────┬───────────────┘
                                        ▼
                 Redis GET trace blob @ agentTraceKey(label)
                       (salt + hashes + reqId-as-string)
                                        ▼
        GM wallet → revealAgentInferenceTrace(keccak phaseId, BigInt(reqId), ...)
                       (serialized, gas-capped, retry)
                                        ▼
                          AgentInferenceRevealed emitted
                                        ▼
                 AgentReport.tsx badge: "committed" → "verified" (green)
```

## Error handling

- **Room not ENDED** → early return, no txs (both triggers).
- **Unknown phase / trace expired / incomplete / actionHash or commitment mismatch** →
  per-slot skip with reason; batch continues. Reported in `skipped[]`. No revert tx is sent
  for a slot we can already tell would fail on-chain.
- **Reveal tx revert / timeout** → per-slot `failed[]` with reason; batch continues; the
  manual endpoint can be re-run (already-revealed slots are skipped, failed ones retried).
- **Double trigger / re-delivered event** → Redis once-claim + on-chain revealed-set make it
  idempotent.
- **GM nonce gap** → handled by the serialized GM wallet client (fix 0e800c5); reveals are
  sequential.

## Testing (TDD, task-by-task)

**Unit — core `revealRoomTraces`** (mock chain getLogs, mock Redis, mock GM wallet):
- happy path: N committed, 0 revealed → N reveal calls, report.revealed == N
- **phaseId mapping**: a committed keccak phaseId resolves to label "D{d}-{KIND}" and the
  Redis GET uses that label; the reveal call receives the **keccak** phaseId (not the label)
- **somniaRequestId coercion**: stored string "12847…" → reveal arg is `BigInt`
- skip already-revealed: slots in revealed-set produce 0 calls
- skip unknown-phase: committed phaseId not in reverse map → `skipped`, no call
- skip expired trace: Redis GET null → `skipped` with `trace-expired`, no call
- skip incomplete trace: missing field → `skipped` with `trace-incomplete`
- skip actionHash mismatch → `skipped` with `actionhash-mismatch`
- partial failure: one reveal throws → `failed[]` populated, remaining slots still processed
- guard: room not ENDED → early return, 0 calls
- idempotency claim: second concurrent call short-circuits on the Redis claim

**Endpoint — `POST /agents/reveal-room`:** returns report JSON; rejects missing/invalid roomId.

**Live smoke (testnet):** run the manual endpoint on **room 72** → confirm
`AgentInferenceRevealed` events on shannon-explorer → confirm Agent Report shows green
"verified" for the revealed actions.

## Files

| File | Change |
|---|---|
| `src/agents/reveal-trace.ts` | NEW — core `revealRoomTraces` + `RevealReport` type (reuses `makePhaseId`/`computeTraceCommitment` from `agents/trace.ts`, `agentTraceKey` from `redis-keys.ts`) |
| `src/routes/agentRoutes.ts` | ADD `POST /agents/reveal-room` |
| ENDED handler (TBD in plan) | ADD fire-and-forget auto-trigger + Redis once-claim |
| `src/agents/redis-keys.ts` | ADD `agentRevealDoneKey(chainId, roomId)` |
| `src/agents/registry-abi.ts` | ADD `revealAgentInferenceTrace(...)` fn + `AgentInferenceRevealed(...)` event to `AGENT_REGISTRY_ABI` (currently only in a doc comment) |
| `src/tests/*` | NEW — core unit tests + endpoint test |

## Open question for the implementation plan

Locate the exact place that observes `GameEnded` for agent games (headless endgame finalizer
vs a listener handler) to host the auto-trigger. Resolve by reading the endgame/finalizer
path during writing-plans.

## Verified against code (2026-06-05)

Checked by reading the source, not assumed (per "verify with data, not reasoning"):

- ✅ **GM == on-chain gameMaster.** `revealAgentInferenceTrace` is `msg.sender == ds.gameMaster`.
  The gm-server's GM wallet (`chain.ts` `gmAccount` from `GM_PRIVATE_KEY`) already signs
  `resolveNightAsGameMaster`, which works live → that EOA *is* the gameMaster → GM-only check passes.
  Use `getChainConfig(chainId).wallet`, the same client `fill-room` uses.
- ✅ **No double-reveal guard** in the contract (re-reveal just re-verifies + re-emits) — so our
  skip-set is an optimisation, not a correctness requirement.
- ⚠️ **phaseId duality** (see boxed section): on-chain = keccak, Redis key = label. Reverse map required.
- ⚠️ **`somniaRequestId` stored as string** in the trace blob (`night.ts:934` → `"0"`; active path
  stores the real id as a decimal string) → coerce with `BigInt` for the `uint256` arg.
- ✅ **Trace blob has all reveal inputs** (`night.ts:932-948`): `salt`, `somniaRequestId`,
  `promptHash`, `responseHash`, `actionHash` (plus a stored `traceCommitment` we can pre-verify against).
- ✅ **Inference commits = VOTING + NIGHT** (and any DAY inference); day *chat* is a separate
  `AgentMessageCommittedV2` (message commit) which the report intentionally keeps as "committed",
  not revealed. Enumeration is commit-event-driven, so we reveal exactly what was inference-committed.

## Honesty note

After this ships, both the deck and the one-pager can state the strong claim truthfully:
post-game reasoning-trace reveal is **done** and **provable on-chain** (`AgentInferenceRevealed`),
not "in development". Aligns the two artifacts on the true version rather than softening to
the weaker one. The UI still never exposes raw prompts/responses (only the verified badge +
tx), so no mid-game role-leak surface is added.

# Mixed human + agent games — Design

**Date:** 2026-05-20
**Status:** Design, approved
**Author:** brainstormed with Haiman

## 1. Context & goal

4j made an **all-agent** room reach DAY (server-side pre-game), live-proven both
in-process and event-driven. The product, however, is **human vs agents**: a
person plays Mafia in the browser against Somnia agents that fill the empty
seats. This spec covers what's needed for that mixed game to run end-to-end.

Most of the mixed flow already works:
- **Entry:** human creates a room (browser), clicks "Add agents" → `/agents/fill-room`
  fills empty seats, clicks Start (`startGame`, host). Phase progression is driven
  by the human's browser (`forcePhaseTimeout` timers) — so the all-agent
  "headless phase progression" gap (see [[headless-phase-progression-gap]]) does
  **not** apply here.
- **SHUFFLING:** `PreGameHandler.handleShuffling` is already mixed-aware — it does
  agent shuffle turns and stops when `currentShufflerIndex` points at a human
  (whose browser does their turn); each `DeckRevealed` re-enters and advances.
- **DAY/VOTING/NIGHT:** agents act via the existing handlers (4d DAY chat — after
  the `PHASE_DAY` 2→3 fix; 4b vote; 4f night); humans act in-browser; the GM
  resolves night.

**The one gap is REVEAL role resolution.** `handleReveal` resolves roles
"server-direct" (decrypt the deck with every player's SRA key), which only works
when the server holds *all* keys — i.e. all-agent. In a mixed game the human's
SRA key lives in their browser, not the server, so server-direct resolution
fails and agents never confirm a role.

Crucially, the GM's own resolution (`/submit-sra-key` → resolve when all keys
present) **also stalls for everyone, including the human**: it needs every
player's key, and the agents never submit theirs. So today a mixed game can't
resolve roles for anyone — the human's `/my-role` would never return either. The
fix below (agents submit their keys into the GM path) is therefore required for
mixed games to resolve at all, and it makes the human's existing flow work too.

(Verified against code: `src/index.ts` shares one `GMStore` between the routes
and the agent subsystem, so the agent poll sees the human's submitted resolution
in-process; `roomPlayerOrder`/fallback are on-chain slot order, so slot i = player
i holds; agent `d` and human key are the same decimal-string format.)

**Goal:** make REVEAL work in a mixed game so every player (human + agents)
resolves and confirms a role → DAY, and a full game runs to a win.

## 2. Approach (chosen: A — server injects agent keys into GM resolution)

In an all-human game the GM already resolves everyone's role once it holds every
player's SRA key: humans POST their key to `/submit-sra-key`, and when all keys
are present the GM decrypts the deck slot-by-slot. In a mixed game the **only**
missing keys are the agents' — and the server already holds those (generated in
`handleShuffling`, persisted in `agents:sra:*`). So the server submits the
agents' keys into the same GM resolution path on their behalf. No gas, no HTTP
self-call (rejected option B), no on-chain `shareKeysToAll` (rejected option C).

## 3. Core: shared role-resolution service

Today the "store key → if all keys present → resolve → persist/sync/WS" logic is
inline in `routes/eciesRoutes.ts` `/submit-sra-key`. Extract it to
`src/services/roleResolution.ts`:

- **`submitSraKey({ store, redis, chainId, roomId, address, sraKey })`** — writes
  the key into `store.sraSKeys` (+ `rPersistSraKey`), then calls
  `maybeResolveRoles`.
- **`maybeResolveRoles({ store, redis, chainId, roomId })`** — reads the room's
  players; if `store.sraSKeys` holds a key for **every** player, read the on-chain
  `getDeck` and the slot order (`store.roomPlayerOrder` ?? on-chain player order),
  decrypt via the existing `resolveRolesFromDeck`, write `store.resolvedRoles`,
  `rPersistRole`, `syncAgentRolesFromResolvedRoles` (→ `agents:role:*`), set room
  mafia for WS, and push `role-ready` to each player. Idempotent — resolves once;
  re-entry while already resolved is a cheap no-op (guard on `resolvedRoles`).
  **After a successful resolve, fire registered `onResolved(chainId, roomId)`
  hooks** (a tiny in-process pub/sub the service owns) so the agent subsystem can
  confirm agent roles immediately, without polling.

`eciesRoutes /submit-sra-key` is refactored to call `submitSraKey` (human-facing
behaviour unchanged; the `getDeck` read + ordering preserved). `resolveRolesFromDeck`
(pure, already extracted in 4j) stays the decrypt core.

## 4. `handleReveal` — all-agent vs mixed branch (NO polling)

```
collect every player's SRA decryption key from redis (agents:sra:*)
  ALL present (all-agent) → server-direct resolve + confirm  [unchanged 4j fast path]
  some missing (humans)  → MIXED, inject only:
    for each OUR agent: submitSraKey(store, agent, its d)   ← into GM resolution
    return immediately (NO poll). Resolution completes when the union of all keys
    (agents injected + human's HTTP submit) is present — whichever key is last
    triggers maybeResolveRoles.
```

**Confirm is decoupled from `handleReveal`** (this is the key correction over a
polling design — see Rationale). Resolution can complete from either path:
- last key is an agent's → `maybeResolveRoles` fires inside the inject call;
- last key is the human's → `maybeResolveRoles` fires inside the HTTP route.

Either way the `onResolved(chainId, roomId)` hook fires. The agent subsystem
registers a hook → **`PreGameHandler.confirmResolvedRoles(chainId, roomId)`**:
for each of our agents in the room with a resolved role (read `store.resolvedRoles`)
and no `FLAG_CONFIRMED_ROLE` → `commitAndConfirmRole(roleHash)` (existing sender,
role salt persisted). Idempotent via the flag + on-chain revert-catch.

**Rationale (why not poll):** the event listener processes logs sequentially
(`for log of logs: await dispatch`), and `dispatch` awaits the handler. A
`handleReveal` that polled up to the 3-min REVEAL deadline would block the
single-threaded listener for *every room* that whole time. The hook makes confirm
event-driven and non-blocking — `handleReveal` returns as soon as it injects.

- `PreGameHandler` gains `store?: GMStore` + `confirmResolvedRoles`. `index.ts`
  already has `store` (it's passed to `startAgentSubsystem`); it passes it to
  `PreGameHandler` and registers the `onResolved` hook → `confirmResolvedRoles`.
  Without a store the mixed branch logs and degrades (prod always has it).
- `confirmResolvedRoles` derives our agents via the existing `resolveMyAgents`;
  confirms are idempotent so a concurrent `handleReveal` (inject-only) can't
  double-spend. The hook invocation is fire-and-forget (errors caught) so it never
  blocks the HTTP response or the listener.

## 5. Components

**New:** `src/services/roleResolution.ts` — `submitSraKey`, `maybeResolveRoles`,
and `registerOnResolved(cb)` / fire-on-resolve pub/sub. Tests:
`test/services/roleResolution.test.ts`.

**Modified:** `routes/eciesRoutes.ts` (call shared `submitSraKey`); `agents/pregame.ts`
(`store` in deps; mixed inject branch in `handleReveal`; new `confirmResolvedRoles`);
`agents/index.ts` (pass `store` to `PreGameHandler`; `registerOnResolved` →
`confirmResolvedRoles`). Tests: extend `test/agents/pregame.test.ts` with a mixed
scenario (fake store; human key arrives → hook → agents confirm); keep the
all-agent test green.

## 6. Edge cases

- **Human AFK (never submits key):** roles never resolve → `onResolved` never
  fires → agents never confirm → `forcePhaseTimeout` aborts the room (refund). No
  hung poll/thread — the handler already returned after injecting.
- **Resolution race:** `maybeResolveRoles` is idempotent — many callers (each key
  submit), resolves exactly once; `onResolved` fires once (guard on first
  transition to resolved).
- **Agent already confirmed:** `FLAG_CONFIRMED_ROLE` check skips re-confirm.
- **Mixed with >1 human:** unchanged — every human submits via browser; agents
  inject; resolution fires when the union of all keys is present.

## 7. Scope

**v1 (this spec):** human(s) + agents reach DAY via mixed REVEAL, then play a full
game to a win using the existing per-phase handlers + browser-driven progression.

**Deferred:** Quick-play one-click vs Agents (thin wrapper over fill-room +
startGame); agent matchmaking auto-join; all-agent headless phase progression
([[headless-phase-progression-gap]], only needed for 0-human demo games).

## 8. Testing

- **Unit:** `roleResolution` — all keys present → resolve + sync + role-ready +
  `onResolved` fires once; partial keys → no-op, no hook. `handleReveal` mixed —
  fake `store` + a "human" player with no agent key: `handleReveal` injects agent
  keys and returns (no confirm yet); then simulate the human's `submitSraKey` →
  resolve → `onResolved` → `confirmResolvedRoles` → agents confirm. Keep the
  all-agent server-direct path test green.
- **Live (real proof):** Haiman in the browser creates a room → "Add agents"
  (3 agents) → Start → play a full game vs the agents to a win, with the gm-server
  running `AGENTS_ENABLED=true`.

## See also
[[agent-pregame-blocker]] (4j), [[headless-phase-progression-gap]],
`src/agents/role-resolve.ts`, `src/routes/eciesRoutes.ts`, `src/agents/pregame.ts`.

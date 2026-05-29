# Agent prompt "full brain" — design

- **Date:** 2026-05-29
- **Status:** Approved (design), pending implementation plan
- **Scope:** `somnia-mafia-gm-server` agents subsystem only (prompt context + a few new pure helpers). No contract change, no frontend change, no transport change.
- **Builds on:** [[2026-05-23-two-way-agent-day-chat-design]] (DAY chat plumbing), [[2026-05-25-headless-zk-endgame-finalizer-design]] (`win-detect.ts`). Reuses the `publicContext[]` / `privateMemory[]` channels every phase prompt already accepts.

## Plain-language summary

Agents play mechanically. They commit votes / kills / messages, but their prompts are missing the things a real Mafia player tracks in their head:

- **No win-state math.** Nobody tells an agent "Mafia win in one more death" or "Town can't afford another mistake." `win-detect.computeWinner` already computes `mafiaCount`/`townCount`, but it is used only by the endgame finalizer — never surfaced to an agent.
- **No role census.** Agents don't know the game's composition ("2 Mafia, 1 Doctor, 1 Detective, 2 Citizens"). The composition is deterministic and public (`generateDistributedDeck` / `LibGame.expectedMafiaCount`) but never stated.
- **Deaths are buried.** `strategic-context` emits one terse recap line ("Last night: X was killed"); the DAY prompt never makes the agent *react* to the body — who benefits, who pushed/defended the victim.
- **Suspicion + ledger engines are dead.** `suspicion.ts` (suspicion/trust vector + vote/kill notes) and `ledger.ts` (votes/kills/deaths + reserved accusation/claim/defense fields) are fully built and unit-tested but **never wired into any prompt** (`day.ts` F6 comment confirms suspicion is "driven by chain events elsewhere" — i.e. nowhere that reaches the LLM).
- **Mafia can shoot Mafia.** The night kill pool is "all alive non-self"; mafia agents don't know their teammates, so the fallback (and the LLM) can target a fellow mafia.

This design wires those in via **six components**. Most of the work is filling the existing `publicContext` / `privateMemory` arrays with better-computed lines; the prompt *structure* of `day.ts` / `night.ts` / `decision-schema.ts` changes only where a behavioral directive is needed (death-reaction opener, voting urgency, mafia coordination).

User decisions captured at brainstorm (2026-05-29):
1. Scope = **both** awareness math **and** wiring suspicion/memory.
2. **Mafia know each other** (classic) — enables coordination + no self-kill.
3. **Roles are revealed only at game end** — mid-game census shows starting composition and how many are dead, but **never the role of a dead player**. ⇒ Town win-math must be **honestly bounded** (worst-case), Mafia win-math can be **exact** (mafia know their own team), and both go to the right channel (public vs private).

## Goals

- Every agent's prompt states the live win-state: who-needs-what-to-win, in numbers, scaled to role knowledge.
- Every agent knows the starting role census and the current alive/dead headcount.
- DAY agents open by reacting to the most recent death (night kill or vote-out) when one happened.
- Each agent receives a short, **chain-derived** "reads" block (who voted against me, who bandwagons together, who flipped) plus its own past stances for consistency.
- Mafia agents know their living teammates and never target them (prompt + fallback).
- Voting consolidates under loss-pressure instead of spraying long-shot votes.
- Role secrecy preserved; no new prompt-injection surface; all injected facts are on-chain-verified.
- Normal (no-agent) games and existing tests untouched.

## Non-goals

- **No chat-content LLM summarization** for suspicion. Reads stay derived from on-chain vote/kill logs (the same `room:logs` `strategic-context` already parses). This keeps the existing F6 safety posture — an attacker can't steer another agent's suspicion by typing a sentence.
- **No revival of the stateful `suspicion.ts` / `ledger.ts` event pipeline.** Their *purpose* (memory + suspicion in prompts) is met by stateless, log-derived computation at prompt-build time (see C4 rationale). The two modules become dead; removal is a clean-up follow-up, out of scope here.
- **No mid-game role reveal of the dead.** Honors decision #3.
- No contract / ABI / ZK changes. No new on-chain reads beyond what handlers already do (`getPlayers`, `isAgent`) plus existing Redis role keyspaces.
- No frontend change. (A spectator-facing "win meter" UI could reuse C1's math later; deferred.)
- No persona overhaul. C6's persona→stance nudge is a one-line touch, not a rework.

## Background facts (verified in code)

- **Role distribution** (`crypto/sra.ts::generateDistributedDeck`, mirrors `LibGame.expectedMafiaCount`):
  `mafia = active≤5?1 : active≤8?2 : active≤11?3 : 4`; `doctor = active≥4?1:0`; `detective = active≥5?1:0`; rest = citizens. So 6 players ⇒ **2 / 1 / 1 / 2**. Deterministic and public.
- **Win rule** (`agents/win-detect.ts::computeWinner`): `mafiaAlive==0 → TOWN`; `mafiaAlive ≥ townAlive → MAFIA`; else ongoing. `townAlive` counts alive players whose role ∈ {DOCTOR, DETECTIVE, CITIZEN}.
- **Role enum** (`agents/roles.ts`): NONE=0, MAFIA=1, DOCTOR=2, DETECTIVE=3, CITIZEN=4. `roleLabel()` exists.
- **Existing prompt channels:**
  - DAY (`agents/day.ts::buildDayPrompt`) takes `publicContext[]`, `privateMemory[]`, `recentChat[]`, `alive[]`, `nameOf`.
  - NIGHT (`agents/night.ts::buildNightPrompt`) takes `publicContext[]`, `privateMemory[]`, `alive[]`, role, tools.
  - VOTING (`agents/decision-schema.ts::buildVotePrompt`) takes `publicContext[]`, `privateMemory[]`, `publicChat[]`, `alive[]`.
- **Shared context** (`agents/strategic-context.ts::loadPublicGameContext`) already parses `room:logs:{chainId}:{roomId}` into vote rounds + night rounds and returns `{ lines, consensusTarget, stalledVoteRounds }`. It already has `majorityNeeded`, `summarizeLatestVoteRecap`, `summarizeLatestNightRecap`, `latestBefore`.
- **Role map source:** `win-detect.resolveRolesWithFallback` reads memory → `gm:room:{c}:{r}:role:*` → `agents:role:{c}:{r}:*`, but it requires a `GMStore`. The agent handlers don't carry a `GMStore`, so this design adds a thin Redis-only reader over the **same keyspaces** (C2) to avoid threading `GMStore` into day/night/voting.

## Architecture

Three new pure modules + targeted edits to three prompt builders and their handlers.

```
NEW agents/game-math.ts        pure: roleCensus(), computeWinMath(), censusLines(), townWinLines(), mafiaWinLines()
NEW agents/reads.ts            pure: deriveReads(voteRounds, self, nameOf) -> string[]
NEW agents/private-strategy.ts redis: loadRoomRoles(); pure: buildPrivateStrategyLines({role, roles, alive, self, nameOf})
EDIT agents/strategic-context.ts  inject census+town-win lines into public lines; expose latestNightDeath/latestVoteOut; add loadAgentReadsLines()
EDIT agents/day.ts             death-reaction opener (C3); append private-strategy + reads to privateMemory (C2/C4)
EDIT agents/night.ts           teammate roster + exclusion in prompt + decodeNightToolCall (C2/C6); append private-strategy
EDIT agents/decision-schema.ts voting urgency directive (C5); (win-math/reads arrive via existing channels)
```

### C1 — Situation Briefing (public, all phases) — `game-math.ts` + `strategic-context.ts`

Prepend to the shared public lines (so DAY, NIGHT-active-roles, and VOTING all inherit it through `loadPublicGameContextLines`):

- **Census** — `censusLines(startingActive)`:
  `"Game setup: {N} players — {m} Mafia, {d} Doctor, {k} Detective, {c} Citizens. Roles are revealed only when the game ends."`
  `startingActive` = total players dealt = current `getPlayers()` length. **Verified:** `chain.getPlayers` is a direct on-chain read of an append-only player array; dead rows keep their slot (only the ACTIVE flag clears), and the ZK deck padding is a circuit concern, not this array — so `players.length` is the starting roster and is stable for the whole game. Mixed games include humans in the same array. Uses the exact `generateDistributedDeck` count rule. Residual risk: a player leaving *before* the deal would shrink the array; doesn't affect mid-game census (deal has happened).
- **Headcount** — `"Alive now: {aliveNow} of {N}. Eliminated so far: {dead} (their roles stay hidden)."`
- **Town win-bound** — `townWinLines({aliveNow, startingMafia})` (honest, no leak):
  - `"Town wins by voting out every Mafia. Town LOSES the instant living Town ≤ living Mafia."`
  - worst-case slack `slack = aliveNow - 2*min(startingMafia, aliveNow)`:
    - `slack > 0`: `"Worst case all {startingMafia} Mafia are still alive — Town can afford to lose at most {slack} more of its own before Mafia can reach parity. Make this vote count."`
    - `slack ≤ 0`: `"If every starting Mafia is still alive, Mafia may already be one good night from parity — do not waste this vote."`

This block is identical for every role (it only uses public info). Mafia *also* get the exact private version in C2.

### C2 — Mafia private win-math + teammate roster (role-conditional) — `private-strategy.ts`

Injected **only** into the agent's private channel, and **only** when `role == MAFIA` (never broadcast, never scrubbed into a public message):

- `loadRoomRoles(redis, chainId, roomId)` → `Map<lowerAddr, AgentRole>`, scanning `agents:role:{c}:{r}:*` (verified format: `agentRoleKey` = `agents:role:{c}:{r}:{addr}`, split index [4]) and `gm:room:{c}:{r}:role:*` (mirrors `resolveRolesWithFallback`'s keyspaces, minus the `GMStore` dependency). **Loaded once per `handle()` call** (not per agent) and passed down — the DAY loop is sequential and VOTING is parallel, so a per-agent scan would be N redundant `KEYS`+`MGET`.
- `buildPrivateStrategyLines({ role: MAFIA, roles, alive, self, nameOf })`:
  - Counts come from reusing `win-detect.computeWinner(players, roles)` — the single source of the win rule — rather than re-deriving (AgentRole and `types/contract.Role` share the same int values, so the map casts directly). `mafiaAlive` includes self; `townAlive = aliveCount − mafiaAlive` (every alive non-Mafia counts as Town).
  - `"Your Mafia team: you + {teammateNames}. Mafia alive: {mafiaAlive}."`
  - `"Exact count — Mafia alive: {mafiaAlive}, Town alive: {townAlive}. You win when Mafia ≥ Town. Town deaths still needed to win: {townAlive − mafiaAlive}."`
  - **Secrecy guard (DAY/VOTING use):** `"Never hint that you know who the other Mafia are. In public, treat your teammates as ordinary players — do not coordinate openly, defend them suspiciously, or say 'we'."` This is required because DAY messages are scrubbed + broadcast; the roster must shape private reasoning without leaking into public text.
  - night-only addendum (added by `night.ts`): `"Never target your own team. Prioritise anyone you can read as Doctor or Detective."`
- **Graceful degrade (mixed games):** if a human Mafia never submitted their SRA key, their role isn't in either keyspace and `mafiaAlive` undercounts. We then emit the bound conservatively and flag it: `"(at least {knownMafiaAlive} Mafia alive — one teammate's role unconfirmed)"`. Agent-only and all-agent games (the common case) resolve fully.
- Town roles (DOCTOR/DETECTIVE) get the public C1 bound + their existing private facts; no exact-mafia line (they don't know it).

### C3 — Death-reaction directive (DAY behavior) — `strategic-context.ts` + `day.ts`

`loadPublicGameContext` additionally returns `latestNightDeath` and `latestVoteOut` (address + resolved name, from the `latestBefore(...)` rounds it already computes). `day.ts::handleOneAgent` passes a new `sinceLastRound` arg to `buildDayPrompt`, which emits a **priority opener** in the user message (only when `dayNumber > 1` and a death exists):

- night kill (`latestNightDeath` set): `"PRIORITY: {Victim} was killed last night. Open by reacting to it — who benefits, who pushed or defended {Victim}, does this kill clear or implicate anyone? Don't ignore the body."`
- peaceful night (`NIGHT_RESULT.isSafe`, no `playerAddress` → `latestNightDeath` null but a night happened): `"PRIORITY: nobody died last night — a save, a missed kill, or a no-op. Who might have been protected (a Doctor read), and who did the Mafia likely aim at?"`
- vote-out last round (`latestVoteOut` set): `"Last round the town voted out {X}. If last night's outcome suggests that was a mistake, say so."`
- first day / nothing happened → unchanged (current "react to latest messages" behavior).

`strategic-context` distinguishes "a night happened but was safe" (a `NIGHT_RESULT` round exists with `killed=null`) from "no night yet" (no round), so day 1 stays silent while a genuine doctor-save fires the peaceful-night opener.

The victim/vote-out are verified public facts, so this stays inside `day.ts`'s existing evidence-discipline rules (no invention).

### C4 — Per-agent "reads" (suspicion + memory, chain-derived) — `reads.ts` + `strategic-context.ts`

`deriveReads(voteRounds, self, nameOf)` (pure, over the vote rounds `strategic-context` already parses) computes a few lines:

- **Voted against me:** rounds where `vote.to == self` → `"{Name} voted against you on Day {d}."`
- **Bandwagon pairs:** voters who repeatedly land on the same target the same day → `"{A} and {B} keep voting together."`
- **Flips:** a voter whose target changed across rounds → `"{C} switched from voting {X} to voting {Y}."`
- **Own stances (consistency):** the agent's own past vote targets → `"You previously voted {X}. Stay consistent unless new evidence changed your mind."`

`loadAgentReadsLines(redis, { chainId, roomId, self, currentDay, nameOf })` re-parses `room:logs` (cheap; reuses `parseVoteRounds`) and returns these lines. Each handler appends them to `privateMemory` alongside detective facts (`memory.ts`) and C2's strategy lines. All chain-derived ⇒ no manipulation surface, consistent with the deliberate F6 stance.

**Rationale for not reviving `suspicion.ts`/`ledger.ts`:** the raw events already live in `room:logs`; computing reads statelessly at prompt-build avoids the event-idempotency/double-count machinery that kept the stateful engine on the shelf, and yields the same chain-derived result. The two modules are superseded (dead-code removal deferred to a follow-up).

### C5 — Voting prompt enrichment — `decision-schema.ts`

`buildVotePrompt` already receives `publicContext` (now carrying C1 win-bound) and `privateMemory` (now carrying C2 mafia-math + C4 reads). Add to its **system** prompt:

- `"Use the situation briefing. If the town is one mistake from losing, do NOT spend your vote on a long-shot — consolidate on your strongest Mafia read or the consensus leader. Never vote a player the public record has effectively cleared."`

Output stays **address-only** (the `inferString` `allowedValues` contract constraint is unchanged). The enrichment is all on the input side.

### C6 — Anti-self-sabotage + persona nudge (low risk) — `night.ts`, `day.ts`

- **Mafia never kill teammates:** `night.ts` passes the teammate set (from C2's `loadRoomRoles`) into `buildNightPrompt` (explicit "your team: …, never target them") **and** into `decodeNightToolCall`, which (a) excludes teammates from the validation pool so an LLM teammate-pick is re-routed, and (b) excludes them from the deterministic fallback pick. Fixes the "mafia shoots mafia" gap at both the LLM and fallback layers.
- **Persona → stance (one line):** `day.ts` maps the pinned persona to a light stance hint (e.g. bold/loud → "take the lead, name a suspect"; cautious/quiet → "probe before committing"). Flavor only; no strategy branching.

## Data flow

```
prompt build (any phase)
  ├─ loadPublicGameContext(room:logs, getPlayers)            [strategic-context.ts]
  │     → census + headcount + town-win-bound (C1)
  │     → vote/night recap, stall, consensus (existing)
  │     → latestNightDeath / latestVoteOut (C3)
  ├─ privateMemory =
  │     detective facts (memory.ts, existing)
  │   + buildPrivateStrategyLines(role, loadRoomRoles())     [private-strategy.ts]  (C2, mafia-only exact)
  │   + loadAgentReadsLines(self)                            [reads.ts via strategic-context]  (C4)
  └─ buildXxxPrompt(publicContext, privateMemory, sinceLastRound, teammates)
        DAY: death-reaction opener (C3) + persona nudge (C6)
        NIGHT: teammate roster + "never target team" (C2/C6) → decodeNightToolCall excludes teammates
        VOTING: urgency directive (C5)
```

## Components and interfaces

| Unit | Responsibility | Pure? | Depends on |
|---|---|---|---|
| `game-math.roleCensus(startingActive)` | starting {mafia,doctor,detective,citizens,total} | yes | — |
| `game-math.computeWinMath({aliveCount, mafiaAlive})` | {townAlive, townDeathsToMafiaWin, ...} | yes | — |
| `game-math.censusLines / townWinLines / mafiaWinLines` | prompt strings | yes | roleCensus/computeWinMath |
| `reads.deriveReads(voteRounds, self, nameOf)` | suspicion/consistency lines | yes | — |
| `private-strategy.loadRoomRoles(redis,c,r)` | room role map | no | redis keyspaces |
| `private-strategy.buildPrivateStrategyLines(args)` | role-conditional private lines | yes | game-math |
| `strategic-context` (extended) | inject C1 lines; expose deaths; `loadAgentReadsLines` | mixed | redis, reads, game-math |
| `day.ts` / `night.ts` / `decision-schema.ts` | wire the above into each prompt | — | the new modules |

## Edge cases and risks

- **Role secrecy.** C2's exact mafia math and teammate names go only to the mafia agent's private channel — never broadcast, never scrubbed into a public message, never given to town roles. Town gets only the public worst-case bound (C1). Consistent with [[feedback_agent_role_secrecy]].
- **Honesty (town math).** Town never receives a fake-precise mafia count; only the honest worst-case slack. Matches the user's honesty value and the "roles hidden until end" rule.
- **Manipulation resistance.** Reads (C4) are derived from on-chain votes/kills only — no chat-text summarization — so a player can't inject suspicion by typing. Preserves the F6 posture.
- **Mixed-game role gaps.** A human teammate who didn't submit an SRA key is invisible to `loadRoomRoles`; C2 degrades to a "known mafia ≥ k" lower bound rather than a wrong exact count. All-agent and fully-submitted mixed games resolve exactly.
- **Census drift from late join / leave.** `startingActive = players.length` assumes the deck was dealt to the current roster. If join/leave after deal is possible, capture starting count from the first `DayStarted` log instead. (Verify during implementation; fall back to logs if `getPlayers` length proves unstable.)
- **First day.** No NIGHT yet → C3 emits nothing; C1 census still shows (composition is known at setup); win-bound shows with full table.
- **`NONE`-role alive players.** `townAlive = aliveCount − mafiaAlive` assumes no alive `NONE`. If any alive player has an unresolved role, mark the math approximate rather than asserting it.
- **Prompt length.** New lines are short and bounded (census 1, headcount 1, win-bound 1–2, reads ≤4, mafia strategy ≤2). Net add ≈ 8–10 lines; well within the existing chat/inference budget.
- **Normal games / no agents.** All new code lives in the agents subsystem and only runs when agents are dispatched. No path change for no-agent rooms.
- **Determinism for audit.** All new helpers are pure functions of (logs, players, roles), so a post-game re-run reproduces the same prompt context — keeps the verify-yourself audit reproducible.

## Testing strategy (TDD)

**New pure modules (vitest, no Redis):**
- `game-math`: census rule at boundaries (5/6/8/9/11/12 players); win-math (2m/3t → 1 death; 1m/1t → MAFIA already; 0m → TOWN); slack sign at parity edge.
- `reads`: voted-against-me, bandwagon detection, flip detection, own-stance line; empty logs → no lines.
- `private-strategy.buildPrivateStrategyLines`: mafia exact line + teammate names; degrade line when a teammate role is missing; town roles → no exact-mafia line.

**Extended `strategic-context` (FakeRedis):**
- public lines now include census + headcount + town-bound; `latestNightDeath`/`latestVoteOut` populated from logs; `loadAgentReadsLines` returns reads.

**Prompt builders:**
- `buildDayPrompt`: death-reaction opener present when `sinceLastRound.nightDeathName` set and `day>1`; absent on day 1 / no death; persona nudge present.
- `buildNightPrompt` (mafia): teammate roster line + "never target team"; `decodeNightToolCall` re-routes a teammate target and excludes teammates from fallback.
- `buildVotePrompt`: urgency directive present in system; output contract (`allowedValues`) unchanged.

**Regression:** existing `day/night/voting` handler tests still pass with the enriched context (assert no crash on empty logs / unresolved roles; mocks return `[]`).

**Manual live smoke (testnet):** all-agent room — confirm (a) DAY message reacts to a night victim, (b) a mafia agent's reveal trace shows the exact-count private line and never targets a teammate, (c) voting consolidates under loss-pressure. Verify via the post-game reveal/trace surface, not by reasoning ([[feedback_verify_with_data_not_reasoning]]).

## File-level change list

**New (`somnia-mafia-gm-server/src/agents/`):**
- `game-math.ts` — `roleCensus`, `computeWinMath`, `censusLines`, `townWinLines`, `mafiaWinLines`. Reuses `win-detect.computeWinner` for alive counts so the win rule lives in exactly one place.
- `reads.ts` — `deriveReads(voteRounds, self, nameOf)`.
- `private-strategy.ts` — `loadRoomRoles(redis, chainId, roomId)`, `buildPrivateStrategyLines(args)`.

**Edited:**
- `strategic-context.ts` — inject C1 lines into `loadPublicGameContext`; add `latestNightDeath`/`latestVoteOut` to its return; add `loadAgentReadsLines(...)`.
- `day.ts` — pass `sinceLastRound` + persona nudge into `buildDayPrompt`; emit death-reaction opener; append `buildPrivateStrategyLines` + `loadAgentReadsLines` to `privateMemory`.
- `night.ts` — load room roles once per `handle()`; derive teammates (mafia addrs − self); pass them into `buildNightPrompt` + `decodeNightToolCall`; append mafia strategy line; exclude teammates from kill pool/fallback. `decodeNightToolCall` gains an **optional** `teammates: Address[] = []` param (it is exported + covered by `night.test.ts`, so the default keeps existing callers/tests green; new behavior added under new cases).
- `decision-schema.ts` — add voting urgency directive to `buildVotePrompt` system text.

**Dead after this change (removal deferred, out of scope):** `suspicion.ts`, `ledger.ts` (+ their tests) — superseded by `reads.ts`.

## Self-review findings (2026-05-29)

Critical pass over the design against the actual code ([[feedback_always_verify_code]], [[feedback_verify_with_data_not_reasoning]]). Verified, then folded fixes in above:

1. **`getPlayers` shape (verified).** `chain.getPlayers` is a direct on-chain read of an append-only player array; dead players keep their slot (ACTIVE flag clears), ZK deck-padding is unrelated. ⇒ `players.length` = starting roster, stable mid-game. Open-question #1 resolved; C1 caveat downgraded to a pre-deal-leave edge.
2. **Role keyspace (verified).** `agentRoleKey` = `agents:role:{c}:{r}:{addr}` exactly matches `resolveRolesWithFallback`'s `agents:role` scan (split idx [4]). `loadRoomRoles` (C2) is sound.
3. **`room:logs` event fields (verified in `logListener.ts`).** Producer emits `PLAYER_VOTED.voterAddress`, `VOTING_RESULT.playerAddress` (eliminated), `NIGHT_RESULT.playerAddress` (killed) **or** `{isSafe:true}` (no `playerAddress`). `strategic-context` already consumes these; C3/C4 inherit a verified parse.
4. **Peaceful-night gap (fixed).** Original C3 only reacted to a kill. A doctor-save emits `NIGHT_RESULT.isSafe` with no victim — a strong signal. C3 now has a peaceful-night opener and distinguishes "safe night happened" from "no night yet (day 1)".
5. **Mafia roster leak (fixed).** Original C2 gave mafia the teammate roster without telling it to hide that knowledge in public DAY chat. Added an explicit secrecy guard line; the roster shapes private reasoning only.
6. **Win-rule duplication (fixed).** C1/C2 now reuse `win-detect.computeWinner` for alive counts instead of re-deriving — one source of truth (AgentRole and `types/contract.Role` share int values).
7. **Redundant role scans (fixed).** `loadRoomRoles` loads once per `handle()` and is passed down, not scanned per agent.
8. **`decodeNightToolCall` signature (fixed).** New `teammates` arg is optional (`= []`) so the exported, unit-tested function keeps existing callers/tests green.

## Open questions

None blocking. One tiny implementation-time check: confirm the `PLAYER_VOTED` log carries `targetAddress` alongside `voterAddress` (the consumer reads it and live vote-recaps work, so it is present — verify when touching `reads.ts`). `gm:room:*:role:*` vs `agents:role` value encoding is already proven uniform by `resolveRolesWithFallback`, which reads both today.

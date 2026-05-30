# Agent chat↔vote coherence + adherence — design

- **Date:** 2026-05-30
- **Status:** Approved-by-delegation ("делай как считаешь нужным"), pending implementation
- **Scope:** `somnia-mafia-gm-server` agents subsystem only — prompt **restructure** (no new context math) + one F6-safe presentation/self-consistency wiring in the vote path. No contract, ABI, ZK, transport, or frontend change. Scrubber **untouched**.
- **Builds on / corrects:** [[2026-05-29-agent-prompt-brain-design]] (the "full brain" content layer). The brain content (census / win-math / reads / death-reaction opener) is already in the prompts and live-proven (room 70). This pass fixes how the *small Somnia inference model under-adheres* to that content, plus a phase-coherence gap between DAY chat and the VOTING ballot.

## Why (live-game findings, room with 6 agents)

The prompt **content** is right; the **conversation** is shallow because the model under-adheres and because two phases speak different languages. Observed:

1. **Repetition / herd.** Day-2 messages are near-copies of Day-1; the phrase "deflecting / avoiding direct answers" parroted across ~6 messages.
2. **Async hallucination.** Agents accuse each other of "dodging questions" — but the format is turn-based, one message per agent per day, **no Q&A exists**. Nobody dodged anything. The existing evidence-discipline line did not stop it.
3. **Self-reference slip.** A Mafia agent (#2) wrote about "Agent #2's behaviour… don't rush to vote them out" — i.e. defended *itself* in the third person. The 3-line anti-self-ref prompt block did not catch it.
4. **Death ignored.** The Doctor was killed N1; Day-2 chat never mentioned the body. The death-reaction opener (C3 of prompt-brain) was present but under-weighted.
5. **★ Chat ≠ vote.** Discussion both days pointed at #2; the actual ballots eliminated #3 then #4. Talk and votes were disconnected.

Root cause for 1–4: a small model that ignores buried instructions. Root cause for 5: see below — it is partly a **name↔address mismatch** and partly the model re-reasoning from scratch at vote time.

## Decisions (this session)

- **Scope = top-3 + cheap wins:** self-ref (#3), chat↔vote (#5), death-reaction (#4) **plus** the two cheap adherence fixes — anti-repeat (#1) and async-no-questions (#2). Stale-dead-reference (#6) deferred.
- **Prompt-first for quality, not the scrubber.** The scrubber's role-leak block is a security guarantee (a probabilistic+weak model will eventually leak a role into the *visible* chat; one slip breaks the game — only a deterministic output gate prevents it; see [[agent-role-secrecy]]). Quality issues (self-ref, deflecting, repetition) are fixed in the **prompt**, because the scrubber can only block (silence the agent → hurts Agent-First) or crudely strip. **No new scrubber rules in this pass.**
- **Accept a model ceiling.** "Perfect prompt" is unreachable with this model; restructure gets most of the way, the remainder is a model limitation. A targeted strip-guard is a *deferred* follow-up, added only for whatever the restructure provably fails to fix on the next live measure ([[feedback_verify_with_data_not_reasoning]]).

## ★ Chat↔vote bridge — F6-safe (corrects the first idea)

**Rejected first idea:** a deterministic "table-lean" that counts how many times each alive player is *mentioned in chat* and feeds the leader to the vote. This **violates the prompt-brain F6 non-goal** ("No chat-content summarization for suspicion … an attacker can't steer another agent's suspicion by typing"). A human could spam "#5 is mafia, vote #5" to inflate the mention count and steer every agent's ballot — manipulation by repetition, not persuasion. Dropped.

**Adopted (three safe parts):**

1. **Presentation parity.** Today `buildVotePrompt` renders alive players and recent chat as **raw short addresses** (`0x1234…: text`) while the DAY chat renders **nicknames**. The model literally cannot connect "vote Alice" (discussed in names) to a ballot whose options are hex. Fix: thread `nameOf` into `buildVotePrompt`; render the alive list, the recent chat, and the consensus cue with nicknames, and present each ballot option as `Alice (0xabcd…)`. `allowedValues` stays **address-only** (the `inferString` contract is unchanged). Pure presentation — **zero** manipulation surface.
2. **Self-consistency (self-only).** Split the already-loaded `publicChat` into the agent's **own** lines (`from == self`) and render them as a short "What you argued today" block, with: *"Vote the read you voiced today unless you are deliberately misdirecting."* This uses **only the agent's own words**, so no other player can steer it by typing — F6-safe. It targets the real defect (an agent's vote ignoring its *own* stated stance), which is more correct than "follow the table" (Mafia bluffing still works).
3. **Keep** the existing chain-derived `consensusTarget` cue (it is from on-chain vote rounds — already F6-safe) and now render it with a nickname too.

This closes the split by making the ballot speak the same language as the discussion and by holding each agent to its own argument — without a gameable chat-derived signal.

## Prompt restructure (DAY) — adherence

All in `buildDayPrompt` (`day.ts`), no new context computed:

- **Hoist the death-reaction opener.** When `dayNumber > 1` and `sinceLastRound.nightDeathName`/`peacefulNight` is set, the opener currently sits mid-`user` after the alive list. Move it to the **first line of the `user` message** (primacy — the one thing a weak model reliably reads). Keep the existing wording. Day-1 / no-death path unchanged.
- **Anti-repeat (#1).** Add one line: *"Do not repeat a point already made (including your own earlier message); add a NEW observation, question, or suspicion, or change your mind with a reason."* The agent's own prior messages are already in `recentChat` as "You:".
- **Async-no-questions (#2).** Add one explicit negative near the evidence-discipline line: *"This is turn-based — one message per player per day. Nobody has asked or answered questions. Never say a player dodged, deflected, evaded, stayed silent on, or avoided a question — there were none."*
- **Self-ref (#3), prompt-only.** Keep the 3-line block; tighten by making the closing reminder the **last** line of the `user` message (recency) and naming the failure mode explicitly: *"You are `{me}`. Do not mention `{me}` at all — not by name, not in the third person, not to defend or analyse yourself. Write only about the OTHER players."*

## Non-goals

- No chat-content summarization of *other* players for any decision (upholds prompt-brain F6 / [[feedback_agent_role_secrecy]]).
- No new scrubber rules; role-leak/temporal/attribution scrubbing unchanged.
- No change to `allowedValues`, hashing (`canonicalPromptHash`, `computeMessageHash`, `computeTraceCommitment`), commit/audit surface, or any tx path.
- No new Redis keys, no new on-chain reads. `buildVotePrompt` reuses the `publicChat` it already receives and the `nameOf` the handler already builds.
- Normal (no-agent) games and their tests untouched.

## File-level change list

**Edited (`somnia-mafia-gm-server/src/agents/`):**
- `decision-schema.ts` — `buildVotePrompt` gains an optional `nameOf?: (addr)=>string` (defaults to short-address, so existing callers/tests stay green); render alive list / recent chat / consensus cue with names; add the "What you argued today" self-only block (filter `publicChat` by `from == self`); add the self-consistency directive to the system text. Output contract unchanged.
- `voting.ts` — pass the handler's existing `nameOf` into `buildVotePrompt`. (No other change; `chatHistory` and `self` already flow in.)
- `day.ts` — `buildDayPrompt` restructure: hoist death opener to first `user` line; add anti-repeat line, async-no-questions negative, and the tightened self-ref reminder as the last `user` line.

**Untouched:** `scrubber.ts`, `strategic-context.ts`, `night.ts`, all hashing/trace code, all contract/ABI.

## Edge cases & risks

- **Hash stability.** `buildDayPrompt`/`buildVotePrompt` output feeds `canonicalPromptHash`/`promptHash`. These changes alter the prompt **text** (expected — the hash just commits whatever prompt was used; audit reproduces it). No format/field change to the hash functions. Existing trace/reveal flow unaffected; only the recorded prompt string differs, which is correct.
- **`nameOf` default.** `buildVotePrompt`'s new param is optional with a short-address default, so any caller/test that doesn't pass it behaves as before.
- **Self-line filter.** `publicChat` entries carry `from`; filtering `from == self` is exact (lowercased compare). If the agent has not spoken yet today, the "What you argued today" block is omitted (no empty header).
- **Prompt length.** Net add ≈ 4 short DAY lines + a small self block in VOTING; well within budget (prompt-brain already validated the channel).
- **Manipulation resistance preserved.** Every newly surfaced signal is either pure presentation (names) or the agent's own text. No other-player chat content drives any decision. F6 posture intact.
- **Model ceiling.** Restructure raises adherence but cannot guarantee it. Measure on the next all-agent live game; only then decide whether a self-ref strip-guard is warranted.

## Testing strategy (TDD)

**`buildVotePrompt` (pure, vitest):**
- With `nameOf`, the prompt contains nicknames for the alive list, recent chat, and consensus cue; ballot options render `Name (0xshort…)`; `allowedValues` is still the address array (contract unchanged).
- Self-only block: present and lists only `from == self` lines when the agent spoke; omitted when it didn't; never includes other players' lines.
- Self-consistency directive present in system text.
- Back-compat: called **without** `nameOf`, output matches the previous short-address format (snapshot/inline assertion) so old behavior is preserved.

**`buildDayPrompt` (pure, vitest):**
- Death opener is the **first** `user` line when `day>1` + death set; absent on day 1 / no death.
- Anti-repeat line present; async-no-questions negative present; self-ref reminder is the **last** `user` line and names `{me}`.

**Regression:** existing `day.test.ts` / `voting.test.ts` / `decision-schema` tests pass (update only the assertions that pin exact prompt strings/ordering; keep `allowedValues` and hash-input shape assertions intact).

**Manual live smoke (testnet, all-agent room):** confirm via the post-game reveal/trace surface — not by reasoning ([[feedback_verify_with_data_not_reasoning]]) — that (a) Day-2 opens on the night victim, (b) messages stop parroting "deflecting" and vary day-to-day, (c) a Mafia agent does not write about itself, (d) an agent's ballot matches the read it voiced (or it bluffed deliberately). Compare vote targets vs each agent's own chat stance.

## Deferred follow-ups

- Self-ref **strip-guard** in `scrubber.ts` (remove the self clause, keep the rest; block only if nothing usable remains) — add **only if** the prompt restructure provably fails on the next live measure.
- Stale-dead-reference (#6) filter — mark eliminated speakers in `recentChat` or drop their lines.
- Dead-code removal of `suspicion.ts` / `ledger.ts` (already noted superseded in prompt-brain spec).

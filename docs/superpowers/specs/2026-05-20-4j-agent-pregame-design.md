# 4j — Agent Pre-Game (server-side shuffle + role) — Design

**Date:** 2026-05-20
**Status:** Design, approved (all-agent v1 scope)
**Author:** brainstormed with Haiman

## 1. Context & goal

Agents currently react only to DAY/VOTING/NIGHT. They cannot pass the pre-game
(SHUFFLING → REVEAL → role-commit), so a game containing agents stalls at shuffle
and aborts. The shuffle/role logic exists only client-side (each human's browser:
`SomniaMafia/services/shuffleService.ts`, `hooks/game/useShuffleActions.ts`,
`hooks/game/useRoleActions.ts`). Agents have no browser; the server never ported it.

**Goal:** server-side handler that performs shuffle + role-commit for agent EOAs
(keys controlled by gm-server via HD mnemonic), driven on SHUFFLING/REVEAL events,
so an **all-agent** game reaches DAY and the existing agent loop plays it out.

This unblocks 4i (full E2E). See memory `agent-pregame-blocker`.

## 2. On-chain protocol (source of truth: `SomniaSol/contracts/facets/ShuffleFacet.sol`)

- **LOBBY → start:** `LobbyFacet.startGame(roomId)` (host only) → SHUFFLING.
- **SHUFFLING (sequential, `room.currentShufflerIndex`):** the player at the current
  index must, within `PHASE_TIMEOUT` (3 min):
  - `commitDeck(roomId, deckHash)` where `deckHash = keccak256(abi.encode(deck, salt))`
  - `revealDeck(roomId, deck, salt)` — advances `currentShufflerIndex` via `findNextActive`.
    When `nextIndex >= playersCount` → `transitionToReveal`.
  - First shuffler reveals the **initial role deck**; each subsequent shuffler re-encrypts +
    re-orders the previous `revealedDeck`.
- **REVEAL (`PHASE_TIMEOUT`):**
  - `shareKeysToAll(roomId, recipients[], encryptedKeys[])` — share own SRA decryption key,
    ECIES-encrypted per recipient. Sets `FLAG_HAS_SHARED_KEYS`, bumps `keysSharedCount`.
    **Not gating** for DAY transition (only emits/accounts).
  - `commitAndConfirmRole(roomId, roleHash)` (or `commitRole` + `confirmRole`) — bumps
    `confirmedCount`. When `confirmedCount == aliveCount` → `transitionToDay`.
  - **Contract does NOT verify the role hash at commit** (only stores it). Hash correctness
    matters only at endgame role reveal / ZK.

## 3. Server-side flow (all-agent v1)

Driven by a new `agents/pregame.ts`, wired into the listener/dispatcher for SHUFFLING and
REVEAL phase events (plus a trigger for `startGame`).

**Start:** when a room our agents fill is in LOBBY and ready (full / host=agent), the
host-agent (or GM) calls `startGame`.

**SHUFFLING (per agent, on its turn):**
1. Detect turn: on `DeckRevealed` / phase poll, if `currentShufflerIndex` points at one of
   our agents and that agent lacks `FLAG_DECK_COMMITTED`, act.
2. First shuffler: build initial role deck (`generateDistributedDeck`, mafiaCount rule
   `≤5→1, ≤8→2, ≤11→3, else 4`). Else: read on-chain `revealedDeck`.
3. Generate verified SRA keys for this agent; `encryptDeck` **in place — NO deck
   re-order**. Verified against `shuffleService.encryptDeck` (a pure `map`) and
   `ShuffleAndReveal.handleMyTurn` (never shuffles the deck): slot i stays player
   i across every re-encryption, so the on-chain player index == deck index, which
   is what role resolution relies on. The only Fisher-Yates is *inside*
   `generateDistributedDeck` (first shuffler, randomising the initial role→slot
   assignment) — not a per-shuffler deck permutation. [verified in impl]
4. `commitDeck(keccak(abi.encode(deck,salt)))` → `revealDeck(deck, salt)`.
5. Persist SRA keys + salt + role-salt in Redis.

**REVEAL (per agent):**
6. `shareKeysToAll` — ECIES-encrypt own SRA decryption key to each recipient's on-chain
   pubkey. (Include for protocol correctness + future mixed games; not gating.)
7. **Role resolution (server-direct):** since the server generated *all* agent SRA keys and
   the final `revealedDeck` is on-chain, decrypt each slot (`sraDecryptCard` +
   `roleFromCardValue`) → role per agent. Write to `store.resolvedRoles` + `rPersistRole`
   + `syncAgentRolesFromResolvedRoles` (→ `agents:role:*`). Reuse the resolution logic from
   `eciesRoutes` `/submit-sra-key` (extract to a shared fn; no HTTP self-call).
8. `commitAndConfirmRole(roleHash)` for each agent. v1 hash = keccak `createRoleCommitHash`
   (endgame-ZK Poseidon deferred). When all confirmed → DAY.

The existing DAY/VOTING/NIGHT agent loop + Codex night-bridge/memory take over.

## 4. Crypto to port (→ extend `gm-server/src/crypto/sra.ts`)

`sra.ts` has decrypt only (`modPow`, `sraDecryptCard`, `getCardOffset`, `roleFromCardValue`).
Port from `shuffleService.ts`:
- `generateKeys` / `generateVerifiedKeys` (+ `generateCoprime`, `gcd`, `modInverse`) — SRA keypair.
- `encrypt` / `encryptDeck`.
- `shuffleArray` (Fisher-Yates).
- `generateDistributedDeck` (initial role deck, offset, mafiaCount rule).
- `createDeckCommitHash` = `keccak256(abi.encode(string[], string))` (viem).
- `createRoleCommitHash` = `keccak256(abi.encode(uint256, string))` (v1; Poseidon later).
- `generateSalt` (32-byte hex, no 0x).
- ECIES **encrypt-to-pubkey** (server has decrypt in `src/ecies.ts`; need encrypt) for
  `shareKeysToAll`.

Use Node `crypto.getRandomValues` / `randomBytes` server-side (browser `crypto` → Node).

## 5. Components

**New:** `src/agents/pregame.ts` (PreGameHandler), `src/agents/sra-shuffle.ts` (or extend
`crypto/sra.ts` with the encrypt/keygen half). Tests: `test/agents/pregame.test.ts`,
`test/crypto/sra-shuffle.test.ts`.

**Modified:** `src/agents/dispatcher.ts` + `listener.ts` (+ SHUFFLING/REVEAL events in
`events.ts`), `src/agents/index.ts` (wire PreGameHandler, pass `store`), `crypto/sra.ts`
(extend), shared role-resolution fn extracted from `eciesRoutes.ts`, `src/agents/chain-ops.ts`
(+ commitDeck/revealDeck/shareKeysToAll/startGame/commitAndConfirmRole senders + currentShufflerIndex read).

## 6. Redis keys

- `agents:sra:{chainId}:{roomId}:{agent}` → `{ e, d }` (SRA keypair). TTL ~1 month (game length).
- `agents:rolesalt:{chainId}:{roomId}:{agent}` → role-commit salt.
- Reuse `agents:ecies:*` (existing keypair), `agents:role:*` (role-sync target).
- Idempotency markers per pre-game step (mirror existing `agentActionProcessedKey` pattern).

## 7. Event handling & turn detection

- SHUFFLING is sequential → cannot fan-out. Handler reacts to `DeckRevealed` (advances index)
  and to `transitionToShuffling`/`startGame`; each tick: read room, if `currentShufflerIndex`
  is our agent and not yet committed → do that agent's shuffle turn.
- REVEAL → can fan-out (parallel) across our agents for shareKeys + commitAndConfirmRole.
- Listener must subscribe to the relevant events; reuse the existing AgentEventListener.

## 8. Idempotency & restart resilience

- On-chain flags are the source of truth: `FLAG_DECK_COMMITTED`, `FLAG_HAS_SHARED_KEYS`,
  `FLAG_CONFIRMED_ROLE`, `roleCommits != 0`. Always check before sending → safe re-entry.
- **SRA keys MUST survive restart** (Redis). If lost mid-shuffle, that agent's committed
  deck can't be reproduced for role resolution → game unrecoverable (acceptable mid-hackathon,
  matches existing `ecies-keys.ts` note). Persist immediately on generation.
- Pairs with the broader 4h listener-backfill gap.

## 9. Edge cases / failures

- **AFK / deadline:** if our agent misses its shuffle turn, `forcePhaseTimeout` on SHUFFLING =
  **abort** (refund). Handler must act well within `PHASE_TIMEOUT`; log + alert on miss.
- **SRA key verification:** `generateVerifiedKeys` retries until encrypt→decrypt roundtrips for
  all card values (avoid fixed points). Keep the retry loop.
- **First-shuffler determinism:** only the first shuffler generates the deck; others must read
  on-chain `revealedDeck`, never regenerate.
- **commit/confirm races:** mirror frontend recovery (already-committed → confirm-only path).
- **Deck size:** must equal `playersCount` (contract checks).

## 10. Scope

**v1 (this spec):** all-agent rooms, headless, testnet. Reach DAY + correct in-game roles
(from `resolvedRoles`). Verified by 4i E2E.

**Deferred:**
- Mixed human+agent (agent acts only on agent seats, tolerates human timing) — superset, same
  handler.
- Endgame-ZK role-hash correctness (Poseidon `/hash-role`) so post-game role reveal verifies.
- `reveal-secret` server DB sync for ZK proofs.

## 11. Testing

- Unit: SRA encrypt/decrypt roundtrip, key verification, deck commit hash == contract keccak,
  `generateDistributedDeck` role counts, role resolution from a known deck+keys.
- Handler: turn detection, idempotent re-entry (flags set), first vs subsequent shuffler,
  REVEAL fan-out, role-resolution → resolvedRoles → role-sync.
- Live E2E (4i): fund N agents, fill room, startGame → observe SHUFFLING→REVEAL→DAY→VOTING→NIGHT
  end-to-end on testnet. This is the real proof.

## 12. Open questions / risks

- **ECIES encrypt server-side:** RESOLVED — `src/ecies.ts` already exports
  `eciesEncrypt(pubkeyHex, msg)` (P-256 + AES-256-GCM, mirrors frontend
  `eciesService`). PreGameHandler uses it for `shareKeysToAll`, which is OFF by
  default (`shareKeysOnChain`) since it never gates DAY and the all-agent server
  resolves roles directly — pure gas otherwise. [verified in impl]
- **startGame trigger:** host-agent vs GM. fill-room currently makes the human creator host;
  for all-agent, decide who is host / who calls startGame.
- **Gas:** commitDeck/revealDeck with full string[] deck can be heavy (revealDeck gas ~14.5M
  per frontend). Ensure agent EOAs funded for it.
- **Cost:** pre-game adds several txs/agent on top of inference deposits — top up sponsor.

## See also
- memory `agent-pregame-blocker`, `night-bridge-memory-integration`, `phase-timers-and-waits`
- `SomniaSol/contracts/facets/ShuffleFacet.sol`, `SomniaMafia/services/shuffleService.ts`
- `gm-server/src/crypto/sra.ts`, `src/routes/eciesRoutes.ts`

# Mafia Onchain — GM Server & Agent Runtime

The TypeScript backend for **Mafia Onchain**, a provably-fair social-deduction game on **Somnia**
where autonomous LLM agents are first-class players. This service does three jobs:

1. **Agent runtime** — drives autonomous LLM players: day debate, voting, and hidden night actions,
   each produced by Somnia **on-chain inference** and committed on-chain.
2. **Game Master (GM)** — handles setup and endgame role reveal; signs GM-only on-chain calls.
3. **Headless driver** — when no human remains, it advances all-agent rooms to a ZK-verified finish.

- **Live demo:** https://mafiaonchain.live
- **Contracts:** https://github.com/light3739/SomniaSol
- **Frontend:** https://github.com/light3739/SomniaMafia

> Agents act from their **own EOAs** and pay their **own gas**. Every turn is a real Somnia
> inference call: `inferChat` for day debate, `inferString` for votes, role-gated `inferToolsChat`
> for night (a mafia agent calls `mafiaKill`, the detective `investigate`, the doctor `protect`).
> Each result lands in ~2–4.5 s and is committed on-chain — verifiable, not server-asserted.

---

## Agent runtime (`src/agents/`)

| Phase / concern | Files |
|---|---|
| Pregame role commit (Poseidon) | `pregame.ts`, `roles.ts`, `role-resolve.ts`, `role-sync.ts` |
| DAY debate (`inferChat`) | `day.ts`, `llm-chat-call.ts`, `chat-store.ts`, `headless-day.ts` |
| VOTING (`inferString`) | `voting.ts`, `llm-call.ts` |
| NIGHT (role-gated `inferToolsChat`) | `night.ts`, `llm-tools-call.ts`, `night-action-bridge.ts` |
| Reasoning over facts | `strategic-context.ts`, `suspicion.ts`, `memory.ts`, `decision-schema.ts`, `personas.ts` |
| Endgame finalize (`endGameZK`) | `headless-endgame.ts`, `groth16.ts`, `win-detect.ts` |
| Funding / wallets | `sponsor.ts`, `agent-funding.ts`, `wallets.ts`, `sweep.ts`, `fill-room.ts` |

### Reliability engineering (the hard part)
Making autonomous on-chain agents reliable under live network conditions drove most of the work:

- **Poll + event race — `wait-for-result.ts`.** Somnia drops `watchContractEvent` logs on fast
  callbacks, so every inference path (`inferChat` / `inferString` / `inferToolsChat`) races an event
  watch against view-polling the result store. This eliminated the dropped-log failure mode for
  votes, kills, and chat.
- **Per-wallet nonce manager — `tx-serializer.ts`.** Serializes txs per wallet with a local nonce
  (`max(chain, local)`), removing contention between concurrent agent wallets (Somnia's pending-nonce
  lags, so serialize-alone was not enough).
- **Per-tx gas caps — `chain-ops.ts`, `groth16.ts`.** Heavy finalizing txs (vote tally, deck reveal,
  `endGameZK` ≈ 62M gas) get explicit caps so viem's estimate can't under-fund them into OOG.
- **Anti-stall + headless drivers — `phase-timeout.ts`, `headless-day.ts`, `turnController.ts`.**
  Agents reason over structured facts (quorum, tallies, night outcomes, own history) and converge a
  headless game in a few rounds; an alive agent forces phase progression when no live human is present.
- **Provably-fair endgame — `headless-endgame.ts`.** All-agent games used to end only via a
  last-player-standing timeout (no verified result). They now finalize through `endGameZK`, signed by
  the winning faction's agent EOA, with on-chain role reveal.

---

## API (`src/routes/`)

Express HTTP + WebSocket. Route groups: `roomRoutes`, `sessionRoutes`, `agentRoutes`,
`discussionRoutes` (day chat), `nightRoutes`, `eciesRoutes` (encrypted role keys), `winRoutes`,
`avatarRoutes`, `logRoutes`. Plus `GET /health` → `{ ok, redis, chain }`.

`POST /agents/fill-room` tops up + joins + registers agents into a room (sponsor-funded), which
unblocks all-agent / mixed games.

---

## Run locally

Node + TypeScript. State in Redis (Memurai works on Windows). Tests via Vitest.

```bash
npm install
cp .env.example .env       # fill the values below
npm run dev                # tsx watch src/index.ts
npm test                   # vitest run
npm run build && npm start # tsc → node dist/index.js
```

### Key environment variables
```bash
GM_PRIVATE_KEY=                 # GM wallet; registered on-chain via setGameMaster(). Never commit.
PORT=3001
SOMNIA_RPC_URL=https://dream-rpc.somnia.network/
SOMNIA_DIAMOND=0x031b6746155ce11c7b533935f4674f5fc4682338

# Agent subsystem
AGENTS_ENABLED=true
AGENTS_CHAIN_IDS=50312
AGENT_MASTER_MNEMONIC=          # HD wallet root for agent EOAs. Never commit.
AGENT_SPONSOR_PRIVATE_KEY=      # funds agent gas. Never commit.
SPONSOR_LOW_THRESHOLD_STT=...   # skip an agent if sponsor balance falls below this

# DAY chat (off by default) + inferChat result sinks (one per chainId)
AGENTS_DAY_ENABLED=false
LLM_CHAT_STORE_50312=0x...
LLM_CHAT_WAIT_MS=60000          # DAY-only timeout CAP (returns early on success); not for VOTING
```

Stack: Node.js · TypeScript · Express · `viem` · Redis (`ioredis`) · `ws` · `snarkjs` +
`circomlibjs` (ZK) · `pino`. Deployed as a Docker container via GHCR + GitHub Actions.

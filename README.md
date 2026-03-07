# Mafia On Chain — Game Master Server

**Part of the [Avalanche Build Games Hackathon](https://www.avax.network/) submission**

The Game Master (GM) server is the trusted off-chain oracle that handles the **Night Phase** of the Mafia On Chain game. It receives encrypted night actions from players, verifies them cryptographically, resolves conflicts (kill vs heal), and posts only the outcome to the smart contract on **Avalanche Fuji**.

Frontend repo: https://github.com/light3739/SomniaMafia  
Live demo: https://mafiaonchain.live

---

## What It Does

In a standard on-chain Mafia game, if every player submits their night action directly to the blockchain, all actions are publicly visible in the mempool — breaking the game's anonymity (everyone could see who the Mafia is targeting).

The GM server solves this:

1. Players send their night actions (kill / heal / investigate) **encrypted + signed** to the GM server off-chain
2. The GM verifies each player's role using their on-chain `roleCommit` hash (ZK-style: `keccak256(role, salt)`)
3. The GM resolves conflicts (if the Doctor healed the Mafia's kill target, the kill is cancelled)
4. The GM posts **only the result** — `resolveNightAsGameMaster(roomId, killTarget, healTarget)` — to the smart contract

This hides WHO performed each action. Only the outcome is on-chain.

---

## Contract Connection

All game state lives on the **MafiaDiamond** Diamond proxy (Avalanche Fuji):

- **Contract address**: `0x3c1bd1923f8318247e2b60e41b0f280391c4e1e1`
- **Explorer**: https://testnet.snowtrace.io/address/0x3c1bd1923f8318247e2b60e41b0f280391c4e1e1\#code
- **GM wallet** is registered on-chain via `setGameMaster(address)` — only this wallet can call `resolveNightAsGameMaster`

---

## API

**Base URL (production)**: `https://gm.mafiaonchain.live`

### `GET /health`
Returns server status, Redis connection, and chain connection.

```json
{ "ok": true, "redis": "ok", "chain": "ok" }
```

### `POST /gm/night-action`
Submit a night action for the GM to process.

**Request body:**
```json
{
  "roomId": "42",
  "playerAddress": "0xYourMainWalletAddress",
  "actionType": "kill",
  "targetAddress": "0xTargetPlayerAddress",
  "signature": "0x...",
  "signerAddress": "0xSessionKeyAddress",
  "role": 1,
  "salt": "randomSaltString"
}
```

| Field | Description |
|---|---|
| `actionType` | `kill` (Mafia), `heal` (Doctor), `check` (Detective) |
| `signature` | EIP-191 signature of `night:{roomId}:{actionType}:{targetAddress}` |
| `role` | `1` = MAFIA, `2` = DOCTOR, `3` = DETECTIVE |
| `salt` | Salt used in `commitAndConfirmRole` — GM uses this to verify the role commit |

**Role verification**: The GM computes `keccak256(abi.encode(role, salt))` off-chain and checks it against the player's `RoleCommitted` event on-chain. Faking a role returns `403`.

### `POST /gm/mafia-chat`
Post an encrypted message to the Mafia-only private channel.

---

## How Role Verification Works

```
Player commits:  keccak256(abi.encode(role, salt))  → stored on-chain
GM receives:     { role: 1, salt: "xyz" }
GM verifies:     keccak256(abi.encode(1, "xyz")) == on-chain commit hash
```

No ZK circuit required server-side — the commitment scheme achieves the same binding property.

---

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Chain client**: Viem (Avalanche Fuji)
- **State**: Redis (room tracking, action deduplication)
- **Auth**: EIP-191 signature verification
- **Transport**: Express.js HTTP

---

## Running Locally

```bash
npm install
cp .env.example .env
# Fill in: PRIVATE_KEY, REDIS_URL, CONTRACT_ADDRESS
npm run dev
```

### Environment Variables

```bash
PRIVATE_KEY=0x...              # GM wallet private key (registered on-chain)
REDIS_URL=redis://localhost:6379
CONTRACT_ADDRESS=0x3c1bd1923f8318247e2b60e41b0f280391c4e1e1
RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
PORT=3001
```

---

## Deployment

The GM server is deployed as a Docker container alongside the frontend. From the frontend monorepo:

```bash
npm run gm:sync     # Sync source into ops/gm-server/source
npm run gm:build    # Build in workdir
npm run gm:publish  # Push to this GitHub repo
npm run gm:deploy   # SSH deploy to production server
# or all at once:
npm run gm:release
```

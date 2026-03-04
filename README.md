# Mafia Game Master (GM) Server

This server handles the off-chain night phase interactions for the Mafia blockchain game. To ensure smooth gameplay and fast resolution, night actions (Kill, Heal, Check) are submitted off-chain to this GM server via signed messages. The GM server authenticates the player, verifies their Role Commit cryptographically (ZK-style verification), and acts as an oracle to batch submit the consolidated results to the Avalanche Fuji blockchain.

## Getting Started
```bash
npm install
npm run dev
# OR
npm run build && npm start
```

## API Endpoint: Night Action

**Endpoint**: `POST https://mafia-voice.serveminecraft.net/gm/night-action`
**Headers**: `Content-Type: application/json`

### Request Body
The JSON body must exactly contain these fields:

```json
{
  "roomId": "65",
  "playerAddress": "0xYourMainWalletAddress",
  "actionType": "kill",
  "targetAddress": "0xTargetPlayerAddress",
  "signature": "0x...",
  "signerAddress": "0xSessionKeyAddress",
  "role": 1,
  "salt": "rand0mSaltString"
}
```

### Parameters Guide

| Field | Type | Description |
|---|---|---|
| `roomId` | `string` or `number` | The ID of the current game room. |
| `playerAddress` | `0x string` | The main wallet address of the player performing the action. |
| `actionType` | `string` | Must be one of: `"kill"`, `"heal"`, or `"check"`. |
| `targetAddress` | `0x string` | The wallet address of the player being targeted. |
| `signature` | `0x string` | Cryptographic signature of the message string. |
| `signerAddress` | `0x string` | *(Optional but recommended)* The address that actually signed the signature (e.g. Session Key). If omitted, the server assumes `playerAddress` signed it. |
| `role` | `number` | The integer value of the player's role (1=MAFIA, 2=DOCTOR, 3=DETECTIVE). |
| `salt` | `string` | The exact string salt that the player used during `commitAndConfirmRole` when hashing their role. |

### The Signature Message
Before sending the request, the frontend must ask the wallet (or session key) to sign a specific message string exactly formatted as follows:

```javascript
const message = `night:${roomId}:${actionType}:${targetAddress}`;
// Example: "night:65:kill:0xTargetPlayerAddress..."
```

*(This must be signed using EIP-191 `personal_sign` / `signMessage` in viem).*

> **Note on Role Verification:**
> The GM server calculates `keccak256(abi.encode(role, salt))` off-chain and mathematically validates it against the player's commit hash (`RoleCommitted` event) to prove the role in a Zero-Knowledge manner. Players faking a role will fail this verification and receive a 403 error.

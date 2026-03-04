import dotenv from 'dotenv';
dotenv.config();

import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

// ─── Chain ────────────────────────────────────────────────
export const avalancheFuji = defineChain({
  id: Number(process.env.CHAIN_ID || 43113),
  name: process.env.CHAIN_NAME || 'Avalanche Fuji C-Chain',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || 'https://api.avax-test.network/ext/bc/C/rpc'] } },
  blockExplorers: { default: { name: 'Snowtrace', url: 'https://testnet.snowtrace.io' } },
  testnet: true,
});

// ─── ABI (only the functions GM server needs) ─────────────
export const DIAMOND_ABI = [
  // NightFacet
  {
    type: 'function',
    name: 'resolveNightAsGameMaster',
    inputs: [
      { name: 'roomId', type: 'uint256' },
      { name: 'killTarget', type: 'address' },
      { name: 'healTarget', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // LobbyFacet — view functions
  {
    type: 'function',
    name: 'getRoom',
    inputs: [{ name: 'roomId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint64' },
          { name: 'host', type: 'address' },
          { name: 'name', type: 'string' },
          { name: 'phase', type: 'uint8' },
          { name: 'maxPlayers', type: 'uint8' },
          { name: 'playersCount', type: 'uint8' },
          { name: 'aliveCount', type: 'uint8' },
          { name: 'dayCount', type: 'uint16' },
          { name: 'currentShufflerIndex', type: 'uint8' },
          { name: 'lastActionTimestamp', type: 'uint32' },
          { name: 'phaseDeadline', type: 'uint32' },
          { name: 'confirmedCount', type: 'uint8' },
          { name: 'votedCount', type: 'uint8' },
          { name: 'committedCount', type: 'uint8' },
          { name: 'revealedCount', type: 'uint8' },
          { name: 'keysSharedCount', type: 'uint8' },
          { name: 'depositPool', type: 'uint128' },
          { name: 'depositPerPlayer', type: 'uint128' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getPlayers',
    inputs: [{ name: 'roomId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'wallet', type: 'address' },
          { name: 'nickname', type: 'string' },
          { name: 'publicKey', type: 'bytes' },
          { name: 'flags', type: 'uint32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'sessionKeys',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'sessionAddress', type: 'address' },
          { name: 'expiresAt', type: 'uint32' },
          { name: 'roomId', type: 'uint64' },
          { name: 'isActive', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  // VotingFacet — role lookup (only populated after revealRole)
  {
    type: 'function',
    name: 'playerRoles',
    inputs: [
      { name: 'roomId', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  // Events we watch
  {
    type: 'event',
    name: 'PhaseChanged',
    inputs: [
      { name: 'roomId', type: 'uint256', indexed: true },
      { name: 'newPhase', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'NightResolvedByGM',
    inputs: [
      { name: 'roomId', type: 'uint256', indexed: true },
      { name: 'killTarget', type: 'address', indexed: false },
      { name: 'healTarget', type: 'address', indexed: false },
    ],
  },
] as const;

// ─── Clients ──────────────────────────────────────────────
const DIAMOND_ADDRESS = (process.env.DIAMOND_ADDRESS || '0x3c1bd1923f8318247e2b60e41b0f280391c4e1e1') as Address;
const RPC_URL = process.env.RPC_URL || 'https://api.avax-test.network/ext/bc/C/rpc';

const gmAccount = privateKeyToAccount(process.env.GM_PRIVATE_KEY as Hex);

export const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http(RPC_URL),
});

export const walletClient = createWalletClient({
  account: gmAccount,
  chain: avalancheFuji,
  transport: http(RPC_URL),
});

export const GM_ADDRESS = gmAccount.address;

// ─── Contract helpers ─────────────────────────────────────

/** GamePhase enum values matching Solidity */
export const GamePhase = {
  LOBBY: 0,
  SHUFFLING: 1,
  REVEAL: 2,
  DAY: 3,
  VOTING: 4,
  NIGHT: 5,
  ENDED: 6,
} as const;

/** FLAG constants matching LibGame.sol exactly */
export const FLAGS = {
  CONFIRMED_ROLE: 0x1,    // FLAG_CONFIRMED_ROLE — set during commitAndConfirmRole()
  ACTIVE: 0x2,            // FLAG_ACTIVE
  HAS_VOTED: 0x4,         // FLAG_HAS_VOTED
  HAS_COMMITTED: 0x8,     // FLAG_HAS_COMMITTED
  HAS_REVEALED: 0x10,     // FLAG_HAS_REVEALED
  HAS_SHARED_KEYS: 0x20,  // FLAG_HAS_SHARED_KEYS
  DECK_COMMITTED: 0x40,   // FLAG_DECK_COMMITTED
  CLAIMED_MAFIA: 0x80,    // FLAG_CLAIMED_MAFIA
  CLAIMED_DETECTIVE: 0x100, // FLAG_CLAIMED_DETECTIVE
} as const;

/** Role enum matching MafiaTypes.sol */
export const Role = {
  NONE: 0,
  MAFIA: 1,
  DOCTOR: 2,
  DETECTIVE: 3,
  CITIZEN: 4,
} as const;

/** Map action type string to required role (used for logging only) */
export const ACTION_TO_ROLE: Record<string, number> = {
  kill: Role.MAFIA,
  heal: Role.DOCTOR,
  check: Role.DETECTIVE,
} as const;

export async function getRoom(roomId: bigint) {
  return publicClient.readContract({
    address: DIAMOND_ADDRESS,
    abi: DIAMOND_ABI,
    functionName: 'getRoom',
    args: [roomId],
  });
}

export async function getPlayers(roomId: bigint) {
  return publicClient.readContract({
    address: DIAMOND_ADDRESS,
    abi: DIAMOND_ABI,
    functionName: 'getPlayers',
    args: [roomId],
  });
}

export async function hasCommittedRole(roomId: bigint, player: Address): Promise<boolean> {
  const players = await getPlayers(roomId);
  const p = players.find(
    (pl) => pl.wallet.toLowerCase() === player.toLowerCase()
  );
  if (!p) return false;
  // FLAG_CONFIRMED_ROLE (0x1) is set when player calls commitAndConfirmRole() in ShuffleFacet
  return (Number(p.flags) & FLAGS.CONFIRMED_ROLE) !== 0;
}

export async function getSessionKey(mainWallet: Address) {
  return publicClient.readContract({
    address: DIAMOND_ADDRESS,
    abi: DIAMOND_ABI,
    functionName: 'sessionKeys',
    args: [mainWallet],
  });
}

export async function resolveNight(roomId: bigint, killTarget: Address, healTarget: Address) {
  const hash = await walletClient.writeContract({
    address: DIAMOND_ADDRESS,
    abi: DIAMOND_ABI,
    functionName: 'resolveNightAsGameMaster',
    args: [roomId, killTarget, healTarget],
  });
  console.log(`[chain] resolveNightAsGameMaster tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[chain] confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
  return { hash, receipt };
}

export async function assertChainConfigOrThrow() {
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== avalancheFuji.id) {
    throw new Error(
      `[chain] Chain mismatch: expected ${avalancheFuji.id} (${avalancheFuji.name}), got ${rpcChainId}. ` +
      `Check CHAIN_ID/RPC_URL in gm-server .env`
    );
  }
}

export { DIAMOND_ADDRESS };

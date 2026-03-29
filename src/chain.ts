import dotenv from 'dotenv';
dotenv.config();

import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

// ─── Chain ────────────────────────────────────────────────
export const avalancheFuji = defineChain({
  id: 43113,
  name: 'Avalanche Fuji C-Chain',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: [process.env.AVAX_RPC_URL || 'https://api.avax-test.network/ext/bc/C/rpc'] } },
  blockExplorers: { default: { name: 'Snowtrace', url: 'https://testnet.snowtrace.io' } },
  testnet: true,
});

export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Testnet',
  nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
  rpcUrls: { default: { http: [process.env.SOMNIA_RPC_URL || 'https://dream-rpc.somnia.network/'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://shannon-explorer.somnia.network' } },
  testnet: true,
});

import { DIAMOND_ABI } from './abi.js';
export { DIAMOND_ABI };

if (!process.env.GM_PRIVATE_KEY) {
  throw new Error('FATAL: GM_PRIVATE_KEY is missing from environment variables');
}
const gmAccount = privateKeyToAccount(process.env.GM_PRIVATE_KEY as Hex);
export const GM_ADDRESS = gmAccount.address;

const AVAX_DIAMOND = (process.env.AVAX_DIAMOND || '0x9f11a8c79d9c59071b4f64f40b0a35cb56645149') as Address;
const SOMNIA_DIAMOND = (process.env.SOMNIA_DIAMOND || '0xe5437f7857cf7abe40de67e8f462b87f9c8eecc8') as Address;

const chainsConfig: Record<number, { public: any, wallet: any, diamond: Address }> = {
  [avalancheFuji.id]: {
    public: createPublicClient({ chain: avalancheFuji, transport: http(avalancheFuji.rpcUrls.default.http[0]) }),
    wallet: createWalletClient({ account: gmAccount, chain: avalancheFuji, transport: http(avalancheFuji.rpcUrls.default.http[0]) }),
    diamond: AVAX_DIAMOND
  },
  [somniaTestnet.id]: {
    public: createPublicClient({ chain: somniaTestnet, transport: http(somniaTestnet.rpcUrls.default.http[0]) }),
    wallet: createWalletClient({ account: gmAccount, chain: somniaTestnet, transport: http(somniaTestnet.rpcUrls.default.http[0]) }),
    diamond: SOMNIA_DIAMOND
  }
};

export function getChainConfig(chainId?: number) {
  const config = chainsConfig[Number(chainId)] || chainsConfig[avalancheFuji.id]; // default to avax if unknown
  return config;
}

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

export async function getRoom(roomId: bigint, chainId?: number) {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'getRoom',
    args: [roomId],
    blockTag: 'pending',
  });
}

export async function getPlayers(roomId: bigint, chainId?: number) {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'getPlayers',
    args: [roomId],
    blockTag: 'pending',
  });
}

export async function hasCommittedRole(roomId: bigint, player: Address, chainId?: number): Promise<boolean> {
  const players = await getPlayers(roomId, chainId);
  const p = players.find(
    (pl: any) => pl.wallet.toLowerCase() === player.toLowerCase()
  );
  if (!p) return false;
  // FLAG_CONFIRMED_ROLE (0x1) is set when player calls commitAndConfirmRole() in ShuffleFacet
  return (Number(p.flags) & FLAGS.CONFIRMED_ROLE) !== 0;
}

export async function getSessionKey(mainWallet: Address, chainId?: number) {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'sessionKeys',
    args: [mainWallet],
    blockTag: 'pending',
  });
}

export async function isTournamentParticipant(tournamentId: bigint, player: Address, chainId?: number): Promise<boolean> {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'isTournamentParticipant',
    args: [tournamentId, player],
    blockTag: 'pending',
  }) as Promise<boolean>;
}

export async function getTournament(tournamentId: bigint, chainId?: number) {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'getTournament',
    args: [tournamentId],
  });
}

export async function resolveNight(roomId: bigint, killTarget: Address, healTarget: Address, chainId?: number) {
  const { wallet: client, public: publicClient, diamond } = getChainConfig(chainId);
  const hash = await client.writeContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'resolveNightAsGameMaster',
    args: [roomId, killTarget, healTarget],
  });
  console.log(`[chain] resolveNightAsGameMaster tx: ${hash} on chainId ${chainId}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[chain] confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
  return { hash, receipt };
}

export async function assertChainConfigOrThrow() {
  // Check both chains
  for (const cid of [avalancheFuji.id, somniaTestnet.id]) {
    const { public: client } = getChainConfig(cid);
    const rpcChainId = await client.getChainId().catch(() => null);
    if (!rpcChainId || rpcChainId !== cid) {
      console.warn(`[chain] Warning: Chain ${cid} not responding correctly (got ${rpcChainId}). Check RPC_URL.`);
    }
  }
}

// ─── Private Room Join Permit ─────────────────────────────────
// Signs keccak256(abi.encodePacked(roomId, playerAddress)) using GM wallet.
// This matches LibGame.verifyGmSignature() on-chain exactly.
import { keccak256, encodePacked } from 'viem';

export async function signJoinPermit(roomId: bigint, playerAddress: Address, chainId: number): Promise<`0x${string}`> {
  const messageHash = keccak256(encodePacked(['uint256', 'uint256', 'address'], [BigInt(chainId), roomId, playerAddress]));
  // signMessage applies EIP-191 prefix ("\x19Ethereum Signed Message:\n32" + hash)
  const signature = await gmAccount.signMessage({ message: { raw: messageHash } });
  return signature;
}


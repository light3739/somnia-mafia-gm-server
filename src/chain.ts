import dotenv from 'dotenv';
dotenv.config();

import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import { DIAMOND_ABI } from './abi.js';
import { GamePhase, Role, FLAGS } from './types/contract.js';
export { DIAMOND_ABI, GamePhase, Role, FLAGS };
import type { Room, Player, Tournament, SessionKeyInfo } from './types/contract.js';

// ─── Chain Definitions ─────────────────────────────────────
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

import { logger } from './utils/logger.js';

if (!process.env.GM_PRIVATE_KEY) {
  throw new Error('FATAL: GM_PRIVATE_KEY is missing from environment variables');
}
const gmAccount = privateKeyToAccount(process.env.GM_PRIVATE_KEY as Hex);
export const GM_ADDRESS = gmAccount.address;
logger.info(`[chain] GM Service initialized with address: ${GM_ADDRESS}`);

const AVAX_DIAMOND = (process.env.AVAX_DIAMOND || '0x9f11a8c79d9c59071b4f64f40b0a35cb56645149') as Address;
const SOMNIA_DIAMOND = (process.env.SOMNIA_DIAMOND || '0xe5437f7857cf7abe40de67e8f462b87f9c8eecc8') as Address;

interface ChainConfig {
  public: any; // using any here to simplify client types, will be narrowed by readContract
  wallet: any;
  diamond: Address;
}

const chainsConfig: Record<number, ChainConfig> = {
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

export function getChainConfig(chainId?: number): ChainConfig {
  return chainsConfig[Number(chainId)] || chainsConfig[avalancheFuji.id];
}

// ─── Contract Helpers ─────────────────────────────────────

export async function getRoom(roomId: bigint, chainId?: number): Promise<Room> {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'getRoom',
    args: [roomId],
    blockTag: 'pending',
  }) as Promise<Room>;
}

export async function getPlayers(roomId: bigint, chainId?: number): Promise<readonly Player[]> {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'getPlayers',
    args: [roomId],
    blockTag: 'pending',
  }) as Promise<readonly Player[]>;
}

export async function hasCommittedRole(roomId: bigint, player: Address, chainId?: number): Promise<boolean> {
  const players = await getPlayers(roomId, chainId);
  const p = players.find(
    (pl) => pl.wallet.toLowerCase() === player.toLowerCase()
  );
  if (!p) return false;
  return (Number(p.flags) & FLAGS.CONFIRMED_ROLE) !== 0;
}

export async function getSessionKey(mainWallet: Address, chainId?: number): Promise<SessionKeyInfo> {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'sessionKeys',
    args: [mainWallet],
    blockTag: 'pending',
  }) as Promise<SessionKeyInfo>;
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

export async function getTournament(tournamentId: bigint, chainId?: number): Promise<Tournament> {
  const { public: client, diamond } = getChainConfig(chainId);
  return client.readContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'getTournament',
    args: [tournamentId],
  }) as Promise<Tournament>;
}

export async function resolveNight(roomId: bigint, killTarget: Address, healTarget: Address, chainId?: number) {
  const { wallet: client, public: publicClient, diamond } = getChainConfig(chainId);
  const hash = await client.writeContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'resolveNightAsGameMaster',
    args: [roomId, killTarget, healTarget],
    chain: null,
  });
  logger.info(`[chain] resolveNightAsGameMaster tx: ${hash} on chainId ${chainId}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  logger.info(`[chain] confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
  return { hash, receipt };
}

export async function assertChainConfigOrThrow() {
  for (const cid of [avalancheFuji.id, somniaTestnet.id]) {
    const { public: client } = getChainConfig(cid);
    try {
      const rpcChainId = await client.getChainId();
      if (rpcChainId !== cid) {
        logger.warn(`[chain] Warning: Chain ${cid} not responding correctly (got ${rpcChainId})`);
      }
    } catch (e: any) {
      logger.warn(`[chain] Warning: Chain ${cid} error: ${e.message}`);
    }
  }
}

// ─── Private Room Join Permit ─────────────────────────────────
import { keccak256, encodePacked } from 'viem';

export async function signJoinPermit(roomId: bigint, playerAddress: Address, chainId: number): Promise<`0x${string}`> {
  const messageHash = keccak256(encodePacked(['uint256', 'uint256', 'address'], [BigInt(chainId), roomId, playerAddress]));
  const signature = await gmAccount.signMessage({ message: { raw: messageHash } });
  return signature;
}

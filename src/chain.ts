import dotenv from 'dotenv';
dotenv.config();

import { createPublicClient, http, webSocket, fallback, type Address, type Hex } from 'viem';
import { serializedWalletClient } from './agents/tx-serializer.js';
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
  rpcUrls: {
    default: {
      http: [process.env.SOMNIA_RPC_URL || 'https://dream-rpc.somnia.network/'],
      webSocket: [process.env.SOMNIA_WS_URL || 'wss://api.infra.testnet.somnia.network/ws'],
    },
  },
  blockExplorers: { default: { name: 'Explorer', url: 'https://shannon-explorer.somnia.network' } },
  testnet: true,
});

export const somniaMainnet = defineChain({
  id: 5031,
  name: 'Somnia',
  nativeCurrency: { name: 'Somnia Token', symbol: 'SOMI', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.SOMNIA_MAINNET_RPC_URL || 'https://api.infra.mainnet.somnia.network/'],
      webSocket: [process.env.SOMNIA_MAINNET_WS_URL || 'wss://api.infra.mainnet.somnia.network/ws'],
    },
  },
  blockExplorers: { default: { name: 'Somnia Explorer', url: 'https://explorer.somnia.network' } },
  testnet: false,
});

import { logger } from './utils/logger.js';

if (!process.env.GM_PRIVATE_KEY) {
  throw new Error('FATAL: GM_PRIVATE_KEY is missing from environment variables');
}
const gmAccount = privateKeyToAccount(process.env.GM_PRIVATE_KEY as Hex);
export const GM_ADDRESS = gmAccount.address;
logger.info(`[chain] GM Service initialized with address: ${GM_ADDRESS}`);

const AVAX_DIAMOND = (process.env.AVAX_DIAMOND || '0x9f11a8c79d9c59071b4f64f40b0a35cb56645149') as Address;
const SOMNIA_DIAMOND = (process.env.SOMNIA_DIAMOND || '0x0406a14729b0c77c187ac5229c8c2317589e73c0') as Address;
const SOMNIA_MAINNET_DIAMOND = (process.env.SOMNIA_MAINNET_DIAMOND || '') as Address;

interface ChainConfig {
  public: any; // using any here to simplify client types, will be narrowed by readContract
  wallet: any;
  diamond: Address;
}

const chainsConfig: Record<number, ChainConfig> = {
  [avalancheFuji.id]: {
    public: createPublicClient({ chain: avalancheFuji, transport: http(avalancheFuji.rpcUrls.default.http[0]) }),
    wallet: serializedWalletClient(gmAccount, avalancheFuji, avalancheFuji.rpcUrls.default.http[0]),
    diamond: AVAX_DIAMOND
  },
  [somniaTestnet.id]: {
    // WebSocket primary for event subscriptions, HTTP fallback for reliability.
    // Wallet client stays HTTP (tx submission doesn't benefit from WS).
    public: createPublicClient({
      chain: somniaTestnet,
      transport: fallback([
        webSocket(somniaTestnet.rpcUrls.default.webSocket![0], {
          reconnect: { delay: 2_000, attempts: 10 },
          keepAlive: { interval: 25_000 },
        }),
        http(somniaTestnet.rpcUrls.default.http[0]),
      ]),
    }),
    wallet: serializedWalletClient(gmAccount, somniaTestnet, somniaTestnet.rpcUrls.default.http[0]),
    diamond: SOMNIA_DIAMOND
  },
};

if (SOMNIA_MAINNET_DIAMOND) {
  chainsConfig[somniaMainnet.id] = {
    public: createPublicClient({
      chain: somniaMainnet,
      transport: fallback([
        webSocket(somniaMainnet.rpcUrls.default.webSocket![0], {
          reconnect: { delay: 2_000, attempts: 10 },
          keepAlive: { interval: 25_000 },
        }),
        http(somniaMainnet.rpcUrls.default.http[0]),
      ]),
    }),
    wallet: serializedWalletClient(gmAccount, somniaMainnet, somniaMainnet.rpcUrls.default.http[0]),
    diamond: SOMNIA_MAINNET_DIAMOND,
  };
  logger.info(`[chain] Somnia Mainnet (5031) configured with diamond: ${SOMNIA_MAINNET_DIAMOND}`);
}

const DEFAULT_CHAIN_ID = Number(process.env.DEFAULT_CHAIN_ID) || somniaTestnet.id;

export function getChainConfig(chainId?: number): ChainConfig {
  const resolved = chainId != null ? Number(chainId) : DEFAULT_CHAIN_ID;
  const config = chainsConfig[resolved];
  if (!config) {
    throw new Error(`Unsupported chainId: ${chainId}. Configured chains: ${Object.keys(chainsConfig).join(', ')}`);
  }
  return config;
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

  // Wait with a 120s timeout so slow Somnia RPCs don't hang forever
  const receipt = await Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('waitForTransactionReceipt timeout after 120s')), 120_000)
    ),
  ]);

  logger.info(`[chain] confirmed in block ${(receipt as any).blockNumber}, status: ${(receipt as any).status}`);
  if ((receipt as any).status === 'reverted') {
    throw new Error(`resolveNightAsGameMaster reverted in block ${(receipt as any).blockNumber}`);
  }
  trackGasCost(chainId, roomId, receipt);
  return { hash, receipt };
}

export async function revealRolesOnChain(
  roomId: bigint,
  players: Address[],
  mappedRoles: number[],
  salts: Hex[],
  chainId?: number
) {
  const { wallet: client, public: publicClient, diamond } = getChainConfig(chainId);
  const hash = await client.writeContract({
    address: diamond,
    abi: DIAMOND_ABI,
    functionName: 'revealRoles',
    args: [roomId, players, mappedRoles, salts],
    chain: null,
  });
  logger.info(`[chain] revealRoles tx: ${hash} for room ${roomId} on chainId ${chainId}`);

  const receipt = await Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('waitForTransactionReceipt timeout after 120s')), 120_000)
    ),
  ]);

  logger.info(`[chain] revealRoles confirmed in block ${(receipt as any).blockNumber}, status: ${(receipt as any).status}`);
  if ((receipt as any).status === 'reverted') {
    throw new Error(`revealRoles reverted in block ${(receipt as any).blockNumber}`);
  }
  trackGasCost(chainId, roomId, receipt);
  return { hash, receipt };
}

// ─── GM Gas Tracking ─────────────────────────────────────
// Tracks cumulative gas cost (wei) the GM spent per room so it can be
// reported on-chain via reportRoomGasCost after the game ends.
// Key: `${chainId}:${roomId}`
const roomGasCosts = new Map<string, bigint>();

function gasKey(chainId: number | undefined, roomId: bigint): string {
  return `${chainId ?? somniaTestnet.id}:${roomId}`;
}

function trackGasCost(chainId: number | undefined, roomId: bigint, receipt: any) {
  const cost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const key = gasKey(chainId, roomId);
  roomGasCosts.set(key, (roomGasCosts.get(key) ?? 0n) + cost);
  logger.info({ roomId: roomId.toString(), gasCost: cost.toString(), total: roomGasCosts.get(key)!.toString() },
    '[gas] Tracked GM gas cost');
}

export async function reportRoomGasCost(roomId: bigint, chainId?: number) {
  const key = gasKey(chainId, roomId);
  const total = roomGasCosts.get(key) ?? 0n;
  if (total === 0n) {
    logger.info({ roomId: roomId.toString() }, '[gas] No GM gas to report');
    return;
  }

  const { wallet: client, public: publicClient, diamond } = getChainConfig(chainId);

  // Check if already reported on-chain (avoid wasting gas on revert)
  try {
    const existing = await publicClient.readContract({
      address: diamond, abi: DIAMOND_ABI,
      functionName: 'getGmGasCost', args: [roomId],
    }) as bigint;
    if (existing > 0n) {
      logger.info({ roomId: roomId.toString() }, '[gas] Already reported on-chain, skipping');
      roomGasCosts.delete(key);
      return;
    }
  } catch { /* getter may not exist on old deployment — proceed */ }

  // Estimate reportRoomGasCost TX cost and add 10% buffer so GM isn't out of pocket
  let reportTxCost = 0n;
  try {
    const gasPrice = BigInt(await publicClient.getGasPrice());
    const gasEst = BigInt(await publicClient.estimateGas({
      account: client.account!.address,
      to: diamond,
      data: '0x', // rough estimate
    }).catch(() => 100000n));
    reportTxCost = gasEst * gasPrice;
  } catch { /* non-critical */ }

  const buffered = total + reportTxCost + (total / 10n); // tracked + report TX cost + 10% buffer
  const cap = 300000000000000000n; // 0.3 SOMI
  const amount = buffered > cap ? cap : buffered;

  // Retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const hash = await client.writeContract({
        address: diamond,
        abi: DIAMOND_ABI,
        functionName: 'reportRoomGasCost',
        args: [roomId, amount],
        chain: null,
      });
      logger.info({ roomId: roomId.toString(), hash, amount: amount.toString(), attempt }, '[gas] reportRoomGasCost tx sent');

      await Promise.race([
        publicClient.waitForTransactionReceipt({ hash }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('reportRoomGasCost timeout')), 30_000)
        ),
      ]);
      logger.info({ roomId: roomId.toString() }, '[gas] reportRoomGasCost confirmed');
      roomGasCosts.delete(key);
      return; // success
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes('Already reported')) {
        logger.info({ roomId: roomId.toString() }, '[gas] Already reported (contract guard)');
        roomGasCosts.delete(key);
        return;
      }
      logger.warn({ err: msg, roomId: roomId.toString(), attempt }, '[gas] reportRoomGasCost attempt failed');
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  logger.error({ roomId: roomId.toString() }, '[gas] reportRoomGasCost failed after 3 attempts');
  roomGasCosts.delete(key);
}

export async function assertChainConfigOrThrow() {
  for (const cid of Object.keys(chainsConfig).map(Number)) {
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

import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import dotenv from 'dotenv';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const DIAMOND_ADDRESS = '0x740d9e5095acc228860509e46cfac1b8a517998c';
const GM_ADDRESS = '0xEF99fbEEbBb7e38B0622794554Ca16a9f651E6Ea';
const DEFAULT_DEPOSIT = parseEther('0.35');

const MINIMAL_ABI = [
  {
    type: 'function',
    name: 'setGameMaster',
    inputs: [{ name: 'gm', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setDefaultDeposit',
    inputs: [{ name: 'deposit', type: 'uint128' }],
    outputs: [],
    stateMutability: 'nonpayable',
  }
] as const;

async function main() {
    if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env");

    const account = privateKeyToAccount(PRIVATE_KEY);
    const publicClient = createPublicClient({
        chain: avalancheFuji,
        transport: http()
    });
    const walletClient = createWalletClient({
        account,
        chain: avalancheFuji,
        transport: http()
    });

    console.log(`Setting up Fuji Diamond at ${DIAMOND_ADDRESS}`);
    console.log(`Using account: ${account.address}`);

    // 1. Set Game Master
    console.log(`\n1. Setting Game Master to ${GM_ADDRESS}...`);
    const gmHash = await walletClient.writeContract({
        address: DIAMOND_ADDRESS,
        abi: MINIMAL_ABI,
        functionName: 'setGameMaster',
        args: [GM_ADDRESS],
    });
    console.log(`   Transaction hash: ${gmHash}`);
    await publicClient.waitForTransactionReceipt({ hash: gmHash });
    console.log(`   ✓ Game Master set`);

    // 2. Set Default Deposit
    console.log(`\n2. Setting Default Deposit to 0.35 AVAX...`);
    const depHash = await walletClient.writeContract({
        address: DIAMOND_ADDRESS,
        abi: MINIMAL_ABI,
        functionName: 'setDefaultDeposit',
        args: [BigInt(DEFAULT_DEPOSIT.toString())],
    });
    console.log(`   Transaction hash: ${depHash}`);
    await publicClient.waitForTransactionReceipt({ hash: depHash });
    console.log(`   ✓ Default Deposit set`);

    console.log("\n=== Configuration Complete ===");
}

main().catch(console.error);

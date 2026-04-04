import { createPublicClient, http } from 'viem';
import { defineChain } from 'viem';
import { DIAMOND_ABI } from './src/abi.ts';

const somniaTestnet = defineChain({
    id: 50312,
    name: 'Somnia Testnet',
    network: 'somnia-testnet',
    nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: ['https://dream-rpc.somnia.network'] } },
});

const client = createPublicClient({ chain: somniaTestnet, transport: http() });

async function main() {
    // We can't access ds.zkVerifier directly, maybe we can read it offchain?
    // Or let's check code of Verifier deployed at some address
}
main();

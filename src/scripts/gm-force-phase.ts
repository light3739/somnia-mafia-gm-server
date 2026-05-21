import 'dotenv/config';
import { createWalletClient, http, parseGwei, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainConfig } from '../chain.js';
import { DIAMOND_ABI } from '../abi.js';

const roomId = BigInt(process.argv[2] ?? '18');
const chainId = Number(process.argv[3] ?? '50312');
const { public: publicClient, diamond } = getChainConfig(chainId);
const chain = publicClient.chain!;
const gm = privateKeyToAccount(process.env.GM_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account: gm, chain, transport: http(chain.rpcUrls.default.http[0]) });

console.log(`forcePhaseTimeout(${roomId}) as GM ${gm.address} ...`);
try {
  const hash = await wallet.writeContract({
    chain,
    address: diamond,
    abi: DIAMOND_ABI as any,
    functionName: 'forcePhaseTimeout',
    args: [roomId],
    gasPrice: parseGwei(String(Number(process.env.TX_GAS_PRICE_GWEI ?? '10'))),
  });
  console.log('tx', hash);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  console.log('status', r.status);
} catch (e: any) {
  console.log('REVERT/ERROR:', (e.shortMessage || e.message || '').split('\n')[0]);
}

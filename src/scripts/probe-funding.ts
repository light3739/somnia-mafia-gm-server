import 'dotenv/config';
import { createPublicClient, http, parseEther, formatEther, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getChainLlmConfig,
  encodeInferStringPayload,
  HANDLE_RESPONSE_SELECTOR,
} from '../agents/llm-call.js';

const rpc = process.env.SOMNIA_RPC_URL!;
const chainId = 50312;
const client = createPublicClient({ transport: http(rpc) });

const sponsor = privateKeyToAccount(process.env.AGENT_SPONSOR_PRIVATE_KEY as Hex);

// Agent EOAs observed in server-mixed.log (room 13 players).
const agents = [
  '0x6E0f32BC81d232C2975eb5bC727a18F8346216C1',
  '0xEda392d996E89af9797DE5A4879C289b26ab3F80',
  '0xd06237bf166dd4D4717e2689E3cf6D415A467eC7',
  '0x0Da3194795CcBBc2afb70e40cD776a54747e49C4',
] as const;

const bal = async (a: string) =>
  formatEther(await client.getBalance({ address: a as Hex }));

console.log('=== BALANCES ===');
console.log('sponsor', sponsor.address, await bal(sponsor.address), 'STT');
for (const a of agents) console.log('agent  ', a, await bal(a), 'STT');

const cfg = getChainLlmConfig(chainId);
const REQ_ABI = parseAbi([
  'function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)',
  'function getRequestDeposit() view returns (uint256)',
]);

console.log('\n=== LLM CONFIG ===');
console.log('requester', cfg.agentRequester, 'store', cfg.store, 'agentId', cfg.agentId.toString());
let deposit = 0n;
try {
  const reserve = (await client.readContract({
    address: cfg.agentRequester, abi: REQ_ABI, functionName: 'getRequestDeposit',
  })) as bigint;
  deposit = reserve + parseEther('0.07') * 3n;
  console.log('getRequestDeposit', formatEther(reserve), 'STT; computed deposit (reserve+0.21)', formatEther(deposit), 'STT');
} catch (e: any) {
  console.log('getRequestDeposit REVERT:', (e.shortMessage || e.message || '').split('\n')[0]);
}

const payload = encodeInferStringPayload({ prompt: 'hi', system: 'test', chainOfThought: false, allowedValues: [] });

console.log('\n=== SIMULATE createRequest (value = computed deposit) ===');
const simFrom = [['sponsor', sponsor.address] as const, ...agents.map((a) => ['agent', a] as const)];
for (const [label, a] of simFrom) {
  try {
    await client.simulateContract({
      account: a as Hex,
      address: cfg.agentRequester, abi: REQ_ABI, functionName: 'createRequest',
      args: [cfg.agentId, cfg.store, HANDLE_RESPONSE_SELECTOR, payload], value: deposit,
    });
    console.log(label, a, '-> OK');
  } catch (e: any) {
    console.log(label, a, '-> REVERT:', (e.shortMessage || e.message || '').split('\n').slice(0, 2).join(' | '));
  }
}

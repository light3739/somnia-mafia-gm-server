/** Verify serializedWalletClient: fire 2 concurrent writeContract from ONE wallet
 * and confirm both mine with sequential nonces (no drop). Before the fix this is
 * exactly what dropped a tx (same nonce). Cost ~0.48 SOMI.
 * Run: npx tsx src/scripts/probe-nonce-fix.ts */
import "dotenv/config";
import { createPublicClient, defineChain, http, parseEther, parseGwei, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { serializedWalletClient } from "../agents/tx-serializer.js";
import { encodeInferStringPayload, getChainLlmConfig, HANDLE_RESPONSE_SELECTOR } from "../agents/llm-call.js";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});
const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
]);

function strip(pk: string | undefined): Hex {
  const m = pk?.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
  if (!m) throw new Error("AGENT_SPONSOR_PRIVATE_KEY missing");
  return (m[0].startsWith("0x") ? m[0] : `0x${m[0]}`) as Hex;
}

async function main() {
  const account = privateKeyToAccount(strip(process.env.AGENT_SPONSOR_PRIVATE_KEY));
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
  const wallet = serializedWalletClient(account, somniaTestnet, somniaTestnet.rpcUrls.default.http[0]);
  const cfg = getChainLlmConfig(50312);
  const reserve = await pc.readContract({ address: cfg.agentRequester, abi: REQUESTER_ABI, functionName: "getRequestDeposit" });
  const deposit = reserve + parseEther("0.07") * 3n;
  const payload = encodeInferStringPayload({ prompt: "ping", system: "", chainOfThought: false, allowedValues: [] });
  const mk = () => wallet.writeContract({
    address: cfg.agentRequester, abi: REQUESTER_ABI, functionName: "createRequest",
    args: [cfg.agentId, cfg.store, HANDLE_RESPONSE_SELECTOR, payload], value: deposit, gasPrice: parseGwei("10"),
  } as any);

  console.log("Firing 2 concurrent writeContract from one wallet via serializedWalletClient...");
  const [h1, h2] = await Promise.all([mk(), mk()]);
  console.log(`tx1=${h1}\ntx2=${h2}`);
  const [r1, r2] = await Promise.all([
    pc.waitForTransactionReceipt({ hash: h1 }),
    pc.waitForTransactionReceipt({ hash: h2 }),
  ]);
  const [t1, t2] = await Promise.all([pc.getTransaction({ hash: h1 }), pc.getTransaction({ hash: h2 })]);
  console.log(`tx1: nonce=${t1.nonce} status=${r1.status}`);
  console.log(`tx2: nonce=${t2.nonce} status=${r2.status}`);
  const ok = r1.status === "success" && r2.status === "success" && Math.abs(t1.nonce - t2.nonce) === 1;
  console.log(`\n${ok ? "✅ FIXED: both mined, sequential nonces (no collision)" : "❌ collision/drop still happens"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

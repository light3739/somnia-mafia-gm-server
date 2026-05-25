/** Read results(reqId) on the inferString store to see if the result is actually
 * stored (vs only the AgentRequester finalizing). Run: npx tsx src/scripts/probe-read-results.ts <reqId> [store] */
import { createPublicClient, defineChain, http, parseAbi, type Hex } from "viem";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});
const ABI = parseAbi([
  "function results(uint256) view returns (bool ready, uint8 status, string text)",
]);

async function main() {
  const reqId = BigInt(process.argv[2]);
  const store = (process.argv[3] ?? "0xb2f30e10454668c8c0c6040d1f3fc9b6ebee0649") as Hex;
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
  const r = (await pc.readContract({ address: store, abi: ABI, functionName: "results", args: [reqId] })) as any;
  console.log(`store ${store} results(${reqId}):`);
  console.log(`  ready=${r[0]} status=${r[1]} text="${String(r[2]).slice(0, 80)}"`);
}
main().catch((e) => { console.error(String(e.shortMessage ?? e.message ?? e)); process.exit(1); });

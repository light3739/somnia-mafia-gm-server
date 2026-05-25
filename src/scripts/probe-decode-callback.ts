/** Decode the handleResponse calldata of the reverted store callback to PROVE the
 * cause: is responses[0] a failed/empty validator while a later one is a valid
 * Success? Run: npx tsx src/scripts/probe-decode-callback.ts <reqId> <fromBlock> <toBlock> */
import { createPublicClient, decodeAbiParameters, parseAbiParameters, defineChain, http, type Hex } from "viem";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});
const REQUESTER = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776" as Hex;
const STORE = "0xb2f30e10454668c8c0c6040d1f3fc9b6ebee0649";
const FINAL_ABI = [{ type: "event", name: "RequestFinalized", inputs: [{ name: "requestId", type: "uint256", indexed: true }, { name: "status", type: "uint8", indexed: false }] }] as const;

// handleResponse(uint256, Response[], uint8, Request)
const PARAMS = parseAbiParameters(
  "uint256 requestId, (address validator, bytes result, uint8 status, uint256 receipt, uint256 timestamp, uint256 executionCost)[] responses, uint8 status, (uint256 id, address requester, address callbackAddress, bytes4 callbackSelector, address[] subcommittee, (address validator, bytes result, uint8 status, uint256 receipt, uint256 timestamp, uint256 executionCost)[] responses, uint256 responseCount, uint256 failureCount, uint256 threshold, uint256 createdAt, uint256 deadline, uint8 status, uint8 consensusType, uint256 remainingBudget, uint256 perAgentBudget) details"
);
const STATUS = ["None", "Pending", "Success", "Failed", "TimedOut"];

function findStoreCall(c: any): any {
  if ((c.to ?? "").toLowerCase() === STORE.toLowerCase()) return c;
  for (const sub of c.calls ?? []) { const f = findStoreCall(sub); if (f) return f; }
  return null;
}

async function main() {
  const reqId = BigInt(process.argv[2]);
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
  const finals = await pc.getLogs({ address: REQUESTER, event: FINAL_ABI[0], args: { requestId: reqId }, fromBlock: BigInt(process.argv[3]), toBlock: BigInt(process.argv[4]) });
  const txHash = finals[0].transactionHash!;
  const trace: any = await pc.request({ method: "debug_traceTransaction" as any, params: [txHash, { tracer: "callTracer" }] as any });
  const storeCall = findStoreCall(trace);
  if (!storeCall) return console.log("no store call found");
  const input = storeCall.input as Hex;
  console.log(`store call error=${storeCall.error} input len=${(input.length - 10) / 2} bytes`);
  const decoded = decodeAbiParameters(PARAMS, ("0x" + input.slice(10)) as Hex);
  const responses = decoded[1] as any[];
  const consensusStatus = Number(decoded[2]);
  console.log(`consensus status=${STATUS[consensusStatus]} responses.length=${responses.length}`);
  responses.forEach((r, i) => {
    const result = r.result as Hex;
    console.log(`  [${i}] validator=${r.validator.slice(0, 10)} status=${STATUS[Number(r.status)]} result.len=${(result.length - 2) / 2}B result=${result.slice(0, 42)}`);
  });
  console.log(`\nresponses[0] is what the store blindly decodes → status=${STATUS[Number(responses[0].status)]}, ${(((responses[0].result as Hex).length - 2) / 2)}B`);
}
main().catch((e) => { console.error(String(e.shortMessage ?? e.message ?? e)); process.exit(1); });

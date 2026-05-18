// Standalone Somnia inferChat smoke against LLMChatResultStore on testnet.
//
// Usage:
//   AGENT_SPONSOR_PRIVATE_KEY=0x... LLM_CHAT_STORE_50312=0x... \
//     node src/scripts/smoke-chat-result-store.mjs
//
// Verifies:
//   - createRequest tx succeeds
//   - ChatResultReady event arrives on the new store
//   - getResult(requestId) returns non-empty response string
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseGwei,
  encodeAbiParameters,
  parseAbiParameters,
  toFunctionSelector,
  defineChain,
  decodeEventLog,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network"] } },
});

const AGENT_REQUESTER = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const STORE = process.env.LLM_CHAT_STORE_50312;
const PK_RAW = process.env.AGENT_SPONSOR_PRIVATE_KEY;
const AGENT_ID = BigInt(process.env.LLM_CHAT_AGENT_ID ?? "12847293847561029384");
if (!STORE) throw new Error("set LLM_CHAT_STORE_50312");
if (!PK_RAW) throw new Error("set AGENT_SPONSOR_PRIVATE_KEY");
const pkMatch = PK_RAW.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
if (!pkMatch) throw new Error("AGENT_SPONSOR_PRIVATE_KEY is not a valid 64-hex key");
const PK = (pkMatch[0].startsWith("0x") ? pkMatch[0] : `0x${pkMatch[0]}`);

const account = privateKeyToAccount(PK);
const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
const wc = createWalletClient({ account, chain: somniaTestnet, transport: http() });

const HANDLE_RESPONSE_SELECTOR = toFunctionSelector(
  "handleResponse(uint256,(address,bytes,uint8,uint256,uint256,uint256)[],uint8,(uint256,address,address,bytes4,address[],(address,bytes,uint8,uint256,uint256,uint256)[],uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint256,uint256))"
);

const payload = encodeAbiParameters(
  parseAbiParameters("string[], string[], bool"),
  [["system", "user"], ["You are a helpful assistant.", "Say hello in 5 words."], false]
);

const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
]);

const STORE_ABI = parseAbi([
  "event ChatResultReady(uint256 indexed requestId, uint8 status)",
  "function getResult(uint256 requestId) view returns ((bool ready, uint8 status, string response))",
]);

console.log("Sender:", account.address);
const bal = await pc.getBalance({ address: account.address });
console.log("Balance:", (Number(bal) / 1e18).toFixed(4), "STT");

const reserve = await pc.readContract({
  address: AGENT_REQUESTER,
  abi: REQUESTER_ABI,
  functionName: "getRequestDeposit",
});
const deposit = reserve + parseEther("0.07") * 3n;
console.log("Deposit (STT):", (Number(deposit) / 1e18).toFixed(4));

const txHash = await wc.writeContract({
  address: AGENT_REQUESTER,
  abi: REQUESTER_ABI,
  functionName: "createRequest",
  args: [AGENT_ID, STORE, HANDLE_RESPONSE_SELECTOR, payload],
  value: deposit,
  gasPrice: parseGwei("10"),
});
console.log("Tx:", txHash);
const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
console.log("Status:", receipt.status);
if (receipt.status !== "success") process.exit(1);

let requestId;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== AGENT_REQUESTER.toLowerCase()) continue;
  try {
    const d = decodeEventLog({ abi: REQUESTER_ABI, topics: log.topics, data: log.data });
    if (d.eventName === "RequestCreated") {
      requestId = d.args.requestId;
      break;
    }
  } catch {}
}
if (!requestId) {
  console.error("RequestCreated event missing in receipt");
  process.exit(1);
}
console.log("RequestId:", requestId.toString());

const deadline = Date.now() + 60_000;
let stored;
while (Date.now() < deadline) {
  stored = await pc.readContract({
    address: STORE,
    abi: STORE_ABI,
    functionName: "getResult",
    args: [requestId],
  });
  if (stored.ready) break;
  await new Promise((r) => setTimeout(r, 1500));
}

if (!stored?.ready) {
  console.error("TIMEOUT waiting for ChatResultReady");
  process.exit(1);
}
console.log("getResult:", stored);
if (!stored.response || stored.response.length === 0) {
  console.error("EMPTY RESPONSE — store guard or LLM failure");
  process.exit(1);
}
console.log("OK — response:", JSON.stringify(stored.response));

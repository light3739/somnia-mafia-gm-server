/**
 * 4e SMOKE — inferToolsChat dummy spike.
 *
 * Derisks the inferToolsChat API before wiring it into the NIGHT handler:
 *   - Validates that our parseAbiParameters layout for the (signature,
 *     description)[] tool tuple is accepted by AgentRequester.
 *   - Confirms createRequest succeeds with an inferToolsChat payload.
 *   - Watches RequestFinalized to see the subcommittee actually runs.
 *
 * Why we do NOT decode the callback here: the existing LLMResultStore on
 * testnet (`0xb2f3...0649`) was wired for inferString — its handleResponse
 * `abi.decode(result, (string))` will revert when fed a tools-response tuple
 * (`(string, string, string[], string[], string[], bytes[])`). For this
 * smoke that's fine: a revert in the callback is still observable via the
 * AgentRequester finalize state, and we get to verify the payload + dispatch
 * + subcommittee selection round-trip works end-to-end.
 *
 * Cost: ~0.24 STT (same deposit as inferString — floor + 0.07×3 subcommittee).
 *
 * Run:
 *   cd somnia-mafia-gm-server
 *   npx tsx smoke-tools-chat.mjs
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  decodeEventLog,
  encodeAbiParameters,
  formatEther,
  http,
  parseAbi,
  parseAbiParameters,
  parseEther,
  parseGwei,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Constants (testnet 50312) ─────────────────────────────────────────
const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

const AGENT_REQUESTER = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const LLM_STORE = "0xb2f30e10454668c8c0c6040d1f3fc9b6ebee0649";
const LLM_AGENT_ID = 12847293847561029384n;

// Sponsor key from gm-server .env (clean key 0x3D9297).
import dotenv from "dotenv";
dotenv.config();
const RAW_KEY = process.env.AGENT_SPONSOR_PRIVATE_KEY;
if (!RAW_KEY) throw new Error("AGENT_SPONSOR_PRIVATE_KEY missing in .env");
const PK = RAW_KEY.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/)[0];
const SPONSOR_KEY = (PK.startsWith("0x") ? PK : `0x${PK}`);

const sponsor = privateKeyToAccount(SPONSOR_KEY);
const publicClient = createPublicClient({
  chain: somniaTestnet,
  transport: http(somniaTestnet.rpcUrls.default.http[0]),
});
const walletClient = createWalletClient({
  account: sponsor,
  chain: somniaTestnet,
  transport: http(somniaTestnet.rpcUrls.default.http[0]),
});

// ─── ABIs ──────────────────────────────────────────────────────────────
const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
  "event RequestFinalized(uint256 indexed requestId, uint8 status)",
]);

const STORE_ABI = parseAbi([
  "event ResultReady(uint256 indexed requestId, uint8 status, string text)",
  "function results(uint256) view returns (bool ready, uint8 status, string text)",
]);

const INFER_TOOLS_CHAT_SELECTOR = toFunctionSelector(
  "inferToolsChat(string[],string[],string[],(string,string)[],uint256,bool)"
);

const HANDLE_RESPONSE_SIG =
  "handleResponse(uint256,(address,bytes,uint8,uint256,uint256,uint256)[],uint8,(uint256,address,address,bytes4,address[],(address,bytes,uint8,uint256,uint256,uint256)[],uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint256,uint256))";
const HANDLE_RESPONSE_SELECTOR = toFunctionSelector(HANDLE_RESPONSE_SIG);

// ─── Build dummy tools payload ─────────────────────────────────────────
// Mimics the eventual NIGHT-phase mafia choice: kill someone or skip.
const roles = ["system", "user"];
const messages = [
  "You are playing Mafia. Tonight you are the Mafia. Pick exactly one target player to eliminate, then call the nightKill tool. If you do not want to kill anyone, call skip.",
  "Alive players: 0x3D92975573E29854e2130d1e70FEd76F76388dc1, 0x691eC350E6C853593A2774640Ac1477754B771C8. Choose now.",
];
const mcpServerUrls = [];
const onchainTools = [
  ["nightKill(uint256 roomId, address target)", "Kill a player at night. Mafia role only."],
  ["skip()", "Skip the night action."],
];
const maxIterations = 1n;
const chainOfThought = false;

const encodedArgs = encodeAbiParameters(
  parseAbiParameters(
    "string[], string[], string[], (string,string)[], uint256, bool"
  ),
  [roles, messages, mcpServerUrls, onchainTools, maxIterations, chainOfThought]
);
const payload = (INFER_TOOLS_CHAT_SELECTOR + encodedArgs.slice(2));

// ─── Pre-flight ────────────────────────────────────────────────────────
console.log("=== 4e inferToolsChat smoke ===");
console.log(`Sponsor   : ${sponsor.address}`);
const balBefore = await publicClient.getBalance({ address: sponsor.address });
console.log(`Balance   : ${formatEther(balBefore)} STT`);

const reserve = await publicClient.readContract({
  address: AGENT_REQUESTER,
  abi: REQUESTER_ABI,
  functionName: "getRequestDeposit",
});
const deposit = reserve + parseEther("0.07") * 3n;
console.log(`Deposit   : ~${formatEther(deposit)} STT  (floor ${formatEther(reserve)} + 0.21 reward)`);
console.log(`Selector  : ${INFER_TOOLS_CHAT_SELECTOR}`);
console.log(`Payload   : ${payload.slice(0, 60)}... (${(payload.length - 2) / 2} bytes)`);

if (balBefore < deposit) {
  throw new Error(
    `Sponsor balance ${formatEther(balBefore)} < deposit ${formatEther(deposit)} — top up via faucet`
  );
}

// ─── Send createRequest ────────────────────────────────────────────────
console.log(`\n→ createRequest...`);
const txHash = await walletClient.writeContract({
  address: AGENT_REQUESTER,
  abi: REQUESTER_ABI,
  functionName: "createRequest",
  args: [LLM_AGENT_ID, LLM_STORE, HANDLE_RESPONSE_SELECTOR, payload],
  value: deposit,
  gasPrice: parseGwei("10"),
});
console.log(`tx: ${txHash}`);
console.log(`explorer: https://shannon-explorer.somnia.network/tx/${txHash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log(`receipt: status=${receipt.status} block=${receipt.blockNumber}`);
if (receipt.status !== "success") throw new Error("createRequest reverted");

// Find requestId
let requestId;
let subcommittee = [];
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== AGENT_REQUESTER.toLowerCase()) continue;
  try {
    const d = decodeEventLog({ abi: REQUESTER_ABI, topics: log.topics, data: log.data });
    if (d.eventName === "RequestCreated") {
      requestId = d.args.requestId;
      subcommittee = d.args.subcommittee;
    }
  } catch {}
}
if (!requestId) throw new Error("RequestCreated event missing");
console.log(`\nRequestCreated: id=${requestId} subcommittee=[${subcommittee.length}]`);
for (const v of subcommittee) console.log(`  - ${v}`);

// ─── Wait for finalize ─────────────────────────────────────────────────
console.log(`\n→ Watching RequestFinalized (timeout 120s)...`);
const finishedStart = Date.now();
const finalStatus = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    unwatch();
    resolve(null);
  }, 120_000);
  const unwatch = publicClient.watchContractEvent({
    address: AGENT_REQUESTER,
    abi: REQUESTER_ABI,
    eventName: "RequestFinalized",
    args: { requestId },
    onLogs: (logs) => {
      for (const log of logs) {
        clearTimeout(timer);
        unwatch();
        resolve(log.args.status);
      }
    },
    onError: (e) => { clearTimeout(timer); unwatch(); reject(e); },
  });
});

const elapsedSec = ((Date.now() - finishedStart) / 1000).toFixed(1);
if (finalStatus === null) {
  console.log(`⏱  timeout after ${elapsedSec}s — subcommittee may still be processing`);
} else {
  console.log(`✅ RequestFinalized after ${elapsedSec}s: status=${finalStatus}`);
  // status enum: 0=None, 1=Pending, 2=Success, 3=Failed, 4=Cancelled (guessed from inferString pattern)
}

// ─── Check store ───────────────────────────────────────────────────────
console.log(`\n→ Check LLMResultStore.results(${requestId})...`);
try {
  const stored = await publicClient.readContract({
    address: LLM_STORE,
    abi: STORE_ABI,
    functionName: "results",
    args: [requestId],
  });
  console.log(`stored: ready=${stored[0]} status=${stored[1]} text="${stored[2].slice(0, 100)}..."`);
} catch (e) {
  console.log(`store read threw: ${e.message}`);
}

const balAfter = await publicClient.getBalance({ address: sponsor.address });
const cost = balBefore - balAfter;
console.log(`\nCost: ${formatEther(cost)} STT  (${formatEther(balAfter)} STT remaining)`);
console.log(`\nDone.`);

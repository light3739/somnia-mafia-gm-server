/**
 * PROBE — why does the NIGHT inferToolsChat path always time out at 60s while
 * the subcommittee finalizes in ~4s (proven by smoke-tools-chat)?
 *
 * Fires ONE inferToolsChat at the REAL night sink (new LLMToolsResultStore
 * 0x85e7e0…) and races three independent signals for 90s:
 *   1. RequestFinalized  (AgentRequester)  — subcommittee done? watch healthy?
 *   2. ToolsResultReady  (tools store)      — the EXACT event the night path waits on
 *   3. getResult(reqId)  (poll, 2s)         — did the store actually get populated?
 *
 * Decisive matrix:
 *   RF yes + TRR no + getResult ready  → H3: event not received (ABI/topic) → fix = POLL
 *   RF yes + TRR no + getResult empty  → H2: store callback reverts        → fix = contract
 *   RF yes + TRR yes (~4s)             → night path should work → env/RPC-in-docker issue
 *
 * Run (from somnia-mafia-gm-server):  node --import tsx src/scripts/probe-night-latency.ts
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  http,
  parseAbi,
  parseEther,
  parseGwei,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeInferToolsChatPayload,
  getChainToolsLlmConfig,
} from "../agents/llm-tools-call.js";
import { HANDLE_RESPONSE_SELECTOR } from "../agents/llm-call.js";

const CHAIN_ID = 50312;
const somniaTestnet = defineChain({
  id: CHAIN_ID,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

function strip(pk: string | undefined): Hex {
  if (!pk) throw new Error("AGENT_SPONSOR_PRIVATE_KEY missing");
  const m = pk.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
  if (!m) throw new Error("PK not hex");
  return (m[0].startsWith("0x") ? m[0] : `0x${m[0]}`) as Hex;
}

const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
  "event RequestFinalized(uint256 indexed requestId, uint8 status)",
]);

const TOOLS_STORE_ABI = parseAbi([
  "event ToolsResultReady(uint256 indexed requestId, uint8 status, string finishReason, uint256 toolCallCount)",
  "event ToolsResultFailed(uint256 indexed requestId, uint8 status)",
  "function getResult(uint256 requestId) view returns ((bool ready, uint8 status, string finishReason, string response, string[] pendingToolCallIds, bytes[] pendingToolCalls))",
]);

const ts = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
let T0 = Date.now();

async function main() {
  const sponsor = privateKeyToAccount(strip(process.env.AGENT_SPONSOR_PRIVATE_KEY));
  const publicClient = createPublicClient({
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });
  const walletClient = createWalletClient({
    account: sponsor,
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });

  const cfg = getChainToolsLlmConfig(CHAIN_ID);
  console.log("=== probe-night-latency ===");
  console.log(`Sponsor      : ${sponsor.address}`);
  console.log(`AgentRequester: ${cfg.agentRequester}`);
  console.log(`Tools store  : ${cfg.toolsStore}   <-- the REAL night sink`);
  console.log(`Agent id     : ${cfg.agentId}`);

  // Same shape as the night mafia prompt (smoke proved this yields tool_calls).
  const payload = encodeInferToolsChatPayload({
    roles: ["system", "user"],
    messages: [
      "You are playing Mafia. You are the Mafia. Pick exactly one target and call nightKill, else call skip.",
      "Alive: 0x3D92975573E29854e2130d1e70FEd76F76388dc1, 0x691eC350E6C853593A2774640Ac1477754B771C8. Choose now.",
    ],
    mcpServerUrls: [],
    onchainTools: [
      { signature: "nightKill(uint256 roomId, address target)", description: "Kill a player at night. Mafia only." },
      { signature: "skip()", description: "Skip the night action." },
    ],
    maxIterations: 1n,
    chainOfThought: false,
  });

  const reserve = await publicClient.readContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "getRequestDeposit",
  });
  const deposit = reserve + parseEther("0.07") * 3n;

  T0 = Date.now();
  const txHash = await walletClient.writeContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "createRequest",
    args: [cfg.agentId, cfg.toolsStore, HANDLE_RESPONSE_SELECTOR, payload],
    value: deposit,
    gasPrice: parseGwei("10"),
  } as any);
  console.log(`\n[${ts()}] createRequest tx ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("createRequest reverted");

  let requestId: bigint | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.agentRequester.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: REQUESTER_ABI, topics: log.topics, data: log.data });
      if (d.eventName === "RequestCreated") requestId = d.args.requestId as bigint;
    } catch {}
  }
  if (!requestId) throw new Error("RequestCreated missing");
  console.log(`[${ts()}] receipt ok, requestId=${requestId}`);

  let rfAt = "", trrAt = "", pollAt = "";

  const unwatchRF = publicClient.watchContractEvent({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    eventName: "RequestFinalized",
    args: { requestId },
    onLogs: (logs) => {
      for (const l of logs) {
        rfAt = ts();
        console.log(`[${rfAt}] ✅ RequestFinalized status=${(l.args as any).status}`);
      }
    },
    onError: (e) => console.log(`[${ts()}] RF watch error: ${e.message}`),
  });

  const unwatchTRR = publicClient.watchContractEvent({
    address: cfg.toolsStore,
    abi: TOOLS_STORE_ABI,
    eventName: "ToolsResultReady",
    args: { requestId },
    onLogs: (logs) => {
      for (const l of logs) {
        trrAt = ts();
        const a = l.args as any;
        console.log(`[${trrAt}] ✅ ToolsResultReady status=${a.status} finishReason=${a.finishReason} toolCalls=${a.toolCallCount}`);
      }
    },
    onError: (e) => console.log(`[${ts()}] TRR watch error: ${e.message}`),
  });

  // Poll getResult every 2s. Do NOT break early — keep the event watchers alive
  // the full window so we can see whether watchContractEvent EVER delivers.
  const pollDeadline = Date.now() + 35_000;
  while (Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!pollAt) {
      try {
        const res = (await publicClient.readContract({
          address: cfg.toolsStore,
          abi: TOOLS_STORE_ABI,
          functionName: "getResult",
          args: [requestId],
        })) as any;
        if (res.ready) {
          pollAt = ts();
          console.log(`[${pollAt}] ✅ getResult READY status=${res.status} finishReason=${res.finishReason} toolCalls=${res.pendingToolCalls.length}`);
          if (res.pendingToolCalls.length > 0) console.log(`        calldata[0]=${res.pendingToolCalls[0].slice(0, 50)}...`);
        }
      } catch (e: any) {
        console.log(`[${ts()}] getResult threw: ${e.shortMessage ?? e.message}`);
      }
    }
  }

  unwatchRF();
  unwatchTRR();

  console.log(`\n=== SUMMARY ===`);
  console.log(`RequestFinalized : ${rfAt || "NEVER (within 90s)"}`);
  console.log(`ToolsResultReady : ${trrAt || "NEVER (within 90s)  <-- night path waits on THIS"}`);
  console.log(`getResult poll   : ${pollAt || "NEVER ready (within 90s)"}`);
  if (rfAt && !trrAt && pollAt) console.log(`\n→ H3: store works, event not received. Fix = POLL getResult instead of watching the event.`);
  else if (rfAt && !trrAt && !pollAt) console.log(`\n→ H2: store callback reverts (finalized but no result). Fix = contract / sink.`);
  else if (trrAt) console.log(`\n→ Night path SHOULD work here. Prod timeout may be env/RPC-in-docker.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Zero-cost root-cause: what event (if any) does the tools store actually emit?
 * Inspects the store's logs around the callback for a known requestId and
 * compares the real topic0 to our ABI's ToolsResultReady / ToolsResultFailed.
 *
 * Run (from somnia-mafia-gm-server): npx tsx src/scripts/probe-store-logs.ts
 */
import "dotenv/config";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  toEventSelector,
  type Hex,
} from "viem";
import { getChainToolsLlmConfig } from "../agents/llm-tools-call.js";

const CHAIN_ID = 50312;
const somniaTestnet = defineChain({
  id: CHAIN_ID,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

// From the probe run.
const CREATE_TX = "0xcf0684fd9b60bee7d04772ae30d735db8be8d2c88cd688ede061dda84f8ff8dd" as Hex;
const REQUEST_ID = 1899165n;

const TOOLS_STORE_ABI = parseAbi([
  "event ToolsResultReady(uint256 indexed requestId, uint8 status, string finishReason, uint256 toolCallCount)",
  "event ToolsResultFailed(uint256 indexed requestId, uint8 status)",
]);

async function main() {
  const pc = createPublicClient({
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });
  const cfg = getChainToolsLlmConfig(CHAIN_ID);
  console.log(`Tools store: ${cfg.toolsStore}`);

  console.log(`\nOur ABI event selectors (topic0):`);
  console.log(`  ToolsResultReady : ${toEventSelector("ToolsResultReady(uint256,uint8,string,uint256)")}`);
  console.log(`  ToolsResultFailed: ${toEventSelector("ToolsResultFailed(uint256,uint8)")}`);

  const rcpt = await pc.getTransactionReceipt({ hash: CREATE_TX });
  const fromBlock = rcpt.blockNumber - 2n;
  const toBlock = rcpt.blockNumber + 300n;
  console.log(`\ncreateRequest block=${rcpt.blockNumber}; scanning store logs ${fromBlock}..${toBlock}`);

  const logs = await pc.getLogs({
    address: cfg.toolsStore as Hex,
    fromBlock,
    toBlock,
  });
  console.log(`\nStore emitted ${logs.length} log(s) in window:`);
  const padReq = "0x" + REQUEST_ID.toString(16).padStart(64, "0");
  for (const l of logs) {
    const matchesReq = l.topics.some((t) => t?.toLowerCase() === padReq.toLowerCase());
    let decoded = "—";
    try {
      const d = decodeEventLog({ abi: TOOLS_STORE_ABI, topics: l.topics, data: l.data });
      decoded = `${d.eventName} ${JSON.stringify(d.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 80)}`;
    } catch (e: any) {
      decoded = `NO MATCH to our ABI (${e.shortMessage ?? e.message ?? "decode failed"})`;
    }
    console.log(`  blk=${l.blockNumber} topic0=${l.topics[0]} #topics=${l.topics.length} reqMatch=${matchesReq}`);
    console.log(`      decode: ${decoded}`);
  }
  if (logs.length === 0) {
    console.log(`  → store emits NOTHING. It only stores getResult state (no event). Night must POLL.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

/** Find an agent's createRequest txs in a block range and report, per request:
 *   createRequest mine time, selector (inferChat vs inferToolsChat),
 *   RequestFinalized time → subcommittee latency.
 * Splits "where did the 25s go" into tx-mining vs oracle compute. Read-only.
 * Run: npx tsx src/scripts/probe-agent-requests.ts <agent> <fromBlock> <toBlock>
 */
import {
  createPublicClient, decodeEventLog, defineChain, http, parseAbi,
  toFunctionSelector, type Hex,
} from "viem";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});
const REQUESTER = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776" as Hex;
const ABI = parseAbi([
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
  "event RequestFinalized(uint256 indexed requestId, uint8 status)",
]);
const SEL_CHAT = toFunctionSelector("inferChat(string[],string[],bool)");
const SEL_TOOLS = toFunctionSelector("inferToolsChat(string[],string[],string[],(string,string)[],uint256,bool)");

async function main() {
  const agent = (process.argv[2] ?? "").toLowerCase();
  const fromBlock = BigInt(process.argv[3]);
  const toBlock = BigInt(process.argv[4]);
  if (!agent) throw new Error("usage: <agent> <fromBlock> <toBlock>");
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });

  const created = await pc.getLogs({ address: REQUESTER, event: ABI[0], fromBlock, toBlock });
  console.log(`RequestCreated in range: ${created.length}; filtering by sender ${agent}`);

  const tsCache = new Map<bigint, number>();
  const blockTs = async (b: bigint) => {
    if (!tsCache.has(b)) tsCache.set(b, Number((await pc.getBlock({ blockNumber: b })).timestamp));
    return tsCache.get(b)!;
  };

  for (const log of created) {
    const tx = await pc.getTransaction({ hash: log.transactionHash! });
    if (tx.from.toLowerCase() !== agent) continue;
    const requestId = (log.args as any).requestId as bigint;
    const payload = (log.args as any).payload as Hex;
    const sel = payload.slice(0, 10).toLowerCase();
    const kind = sel === SEL_CHAT.toLowerCase() ? "inferChat(VOTE/DAY)" : sel === SEL_TOOLS.toLowerCase() ? "inferToolsChat(NIGHT)" : `?(${sel})`;
    const createTs = await blockTs(log.blockNumber!);

    const finals = await pc.getLogs({ address: REQUESTER, event: ABI[1], args: { requestId }, fromBlock: log.blockNumber!, toBlock: log.blockNumber! + 900n });
    let finalInfo = "NOT finalized in range";
    if (finals.length) {
      const fTs = await blockTs(finals[0].blockNumber!);
      finalInfo = `finalized status=${(finals[0].args as any).status} after ${fTs - createTs}s (block +${Number(finals[0].blockNumber! - log.blockNumber!)})`;
    }
    console.log(`\nreq ${requestId}  ${kind}\n  createRequest block=${log.blockNumber} ts=${createTs}\n  ${finalInfo}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

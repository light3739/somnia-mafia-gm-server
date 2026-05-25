/** Find the RequestFinalized tx for a requestId and inspect why the store callback
 * didn't populate results: receipt status, all emitted logs, and a callTracer trace
 * (if the RPC supports debug_traceTransaction) to surface the handleResponse revert.
 * Run: npx tsx src/scripts/probe-finalize-tx.ts <reqId> <fromBlock> <toBlock> */
import { createPublicClient, defineChain, http, parseAbi, type Hex } from "viem";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});
const REQUESTER = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776" as Hex;
const STORE = "0xb2f30e10454668c8c0c6040d1f3fc9b6ebee0649";
const ABI = parseAbi([
  "event RequestFinalized(uint256 indexed requestId, uint8 status)",
]);

async function main() {
  const reqId = BigInt(process.argv[2]);
  const fromBlock = BigInt(process.argv[3]);
  const toBlock = BigInt(process.argv[4]);
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });

  const finals = await pc.getLogs({ address: REQUESTER, event: ABI[0], args: { requestId: reqId }, fromBlock, toBlock });
  if (!finals.length) return console.log("no RequestFinalized in range");
  const txHash = finals[0].transactionHash!;
  console.log(`finalize tx = ${txHash} (block ${finals[0].blockNumber})`);

  const rcpt = await pc.getTransactionReceipt({ hash: txHash });
  console.log(`receipt status=${rcpt.status} gasUsed=${rcpt.gasUsed} logs=${rcpt.logs.length}`);
  for (const l of rcpt.logs) {
    const isStore = l.address.toLowerCase() === STORE.toLowerCase();
    console.log(`  log addr=${l.address}${isStore ? " (STORE)" : ""} topic0=${l.topics[0]}`);
  }

  // Try a call trace for the internal handleResponse revert reason.
  try {
    const trace: any = await pc.request({
      method: "debug_traceTransaction" as any,
      params: [txHash, { tracer: "callTracer" }] as any,
    });
    const decodeRevert = (out?: string): string => {
      if (!out || out === "0x") return "(no revert data)";
      // Error(string) selector 0x08c379a0
      if (out.startsWith("0x08c379a0")) {
        try {
          const hex = out.slice(10 + 64); // skip selector + offset
          const lenHex = hex.slice(0, 64);
          const len = parseInt(lenHex, 16);
          const strHex = hex.slice(64, 64 + len * 2);
          return Buffer.from(strHex, "hex").toString("utf8");
        } catch { return out.slice(0, 80); }
      }
      return `selector ${out.slice(0, 10)} (custom error / panic)`;
    };
    const walk = (c: any, depth = 0) => {
      const to = (c.to ?? "").toLowerCase();
      const tag = to === STORE.toLowerCase() ? " <-- STORE" : "";
      const g = c.gas ? parseInt(c.gas, 16) : 0;
      const gu = c.gasUsed ? parseInt(c.gasUsed, 16) : 0;
      const gasInfo = c.error ? ` gas=${g} gasUsed=${gu}${g > 0 && gu >= g - 50 ? " (OOG: used≈provided!)" : ""}` : "";
      const rev = c.error ? ` revert="${decodeRevert(c.output)}"${gasInfo}` : "";
      console.log(`  ${"  ".repeat(depth)}call to=${c.to} type=${c.type} ${c.error ? "ERROR=" + c.error : "ok"}${rev}${tag}`);
      for (const sub of c.calls ?? []) walk(sub, depth + 1);
    };
    console.log("=== callTracer ===");
    walk(trace);
  } catch (e: any) {
    console.log(`(debug_traceTransaction unsupported: ${String(e.shortMessage ?? e.message ?? e).slice(0, 80)})`);
  }
}
main().catch((e) => { console.error(String(e.shortMessage ?? e.message ?? e)); process.exit(1); });

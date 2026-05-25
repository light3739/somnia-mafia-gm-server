/** Trace a mined-reverted tx and decode the revert reason (Error(string) or a
 * custom-error selector). Run: npx tsx src/scripts/probe-trace-tx.ts <txHash> */
import { createPublicClient, defineChain, http, type Hex } from "viem";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

function decodeRevert(out?: string): string {
  if (!out || out === "0x") return "(no data — bare revert/require or OOG)";
  if (out.startsWith("0x08c379a0")) {
    try {
      const hex = out.slice(10 + 64);
      const len = parseInt(hex.slice(0, 64), 16);
      return `Error("${Buffer.from(hex.slice(64, 64 + len * 2), "hex").toString("utf8")}")`;
    } catch { return out.slice(0, 80); }
  }
  if (out.startsWith("0x4e487b71")) return `Panic(0x${out.slice(-2)})`;
  return `custom error selector ${out.slice(0, 10)}`;
}

async function main() {
  const txHash = process.argv[2] as Hex;
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
  const trace: any = await pc.request({ method: "debug_traceTransaction" as any, params: [txHash, { tracer: "callTracer" }] as any });
  const walk = (c: any, d = 0) => {
    console.log(`${"  ".repeat(d)}to=${c.to} type=${c.type} ${c.error ? "ERROR=" + c.error + " revert=" + decodeRevert(c.output) : "ok"}`);
    for (const sub of c.calls ?? []) walk(sub, d + 1);
  };
  walk(trace);
}
main().catch((e) => { console.error(String(e.shortMessage ?? e.message ?? e)); process.exit(1); });

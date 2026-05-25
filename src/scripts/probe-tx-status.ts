/** Print nonce/block/status for tx hashes + the agent's current nonce. Diagnoses
 * stuck/replaced txs (nonce collision). Read-only.
 * Run: npx tsx src/scripts/probe-tx-status.ts <agent> <txHash...> */
import { createPublicClient, defineChain, http, type Hex } from "viem";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

async function main() {
  const [agent, ...hashes] = process.argv.slice(2);
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
  if (agent) {
    const n = await pc.getTransactionCount({ address: agent as Hex });
    const pending = await pc.getTransactionCount({ address: agent as Hex, blockTag: "pending" });
    console.log(`agent ${agent}  nonce(latest)=${n}  nonce(pending)=${pending}\n`);
  }
  for (const h of hashes) {
    try {
      const tx = await pc.getTransaction({ hash: h as Hex });
      let status = "pending(no receipt)";
      try {
        const r = await pc.getTransactionReceipt({ hash: h as Hex });
        status = r.status;
      } catch { /* no receipt */ }
      console.log(`${h}\n  nonce=${tx.nonce} block=${tx.blockNumber ?? "—"} status=${status}`);
    } catch {
      console.log(`${h}\n  NOT FOUND (dropped/replaced — never mined)`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

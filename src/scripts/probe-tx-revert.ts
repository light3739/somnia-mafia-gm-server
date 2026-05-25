/** Replay a mined-but-reverted tx to recover its revert reason. Read-only.
 * Run: npx tsx src/scripts/probe-tx-revert.ts <txHash> */
import { createPublicClient, defineChain, http, type Hex } from "viem";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

async function main() {
  const hash = (process.argv[2] ?? "") as Hex;
  if (!hash) throw new Error("usage: probe-tx-revert <txHash>");
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });
  const tx = await pc.getTransaction({ hash });
  console.log(`tx ${hash}\n from=${tx.from} to=${tx.to} block=${tx.blockNumber} nonce=${tx.nonce}`);
  try {
    await pc.call({
      account: tx.from,
      to: tx.to ?? undefined,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      blockNumber: tx.blockNumber ?? undefined,
    } as any);
    console.log("call did NOT revert at that block (state-dependent race?)");
  } catch (e: any) {
    console.log(`REVERT REASON: ${e.shortMessage ?? e.message}`);
    if (e.metaMessages) console.log(e.metaMessages.join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

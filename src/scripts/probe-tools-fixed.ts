/**
 * Live verification of the PATCHED night path: calls the real
 * inferToolsChatOnSomnia (now poll+event race) and prints latency. Before the
 * fix this timed out at waitMs (~60s, status 0). After the fix the poll should
 * deliver the tool call in ~2-4s (status 2, finishReason tool_calls).
 *
 * Run (from somnia-mafia-gm-server): npx tsx src/scripts/probe-tools-fixed.ts
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inferToolsChatOnSomnia } from "../agents/llm-tools-call.js";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

function strip(pk: string | undefined): Hex {
  const m = pk?.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
  if (!m) throw new Error("AGENT_SPONSOR_PRIVATE_KEY missing/invalid");
  return (m[0].startsWith("0x") ? m[0] : `0x${m[0]}`) as Hex;
}

async function main() {
  const sponsor = privateKeyToAccount(strip(process.env.AGENT_SPONSOR_PRIVATE_KEY));
  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });
  const walletClient = createWalletClient({ account: sponsor, chain: somniaTestnet, transport: http() });

  console.log("=== probe-tools-fixed (patched night path) ===");
  const infer = await inferToolsChatOnSomnia(
    {
      roles: ["system", "user"],
      messages: [
        "You are playing Mafia. You are the Mafia. Pick exactly one target and call nightKill, else skip.",
        "Alive: 0x3D92975573E29854e2130d1e70FEd76F76388dc1, 0x691eC350E6C853593A2774640Ac1477754B771C8. Choose now.",
      ],
      mcpServerUrls: [],
      onchainTools: [
        { signature: "nightKill(uint256 roomId, address target)", description: "Kill a player at night. Mafia only." },
        { signature: "skip()", description: "Skip the night action." },
      ],
      maxIterations: 1,
      chainOfThought: false,
    },
    { publicClient, walletClient, chainId: 50312, waitMs: 60_000 }
  );

  console.log(`latencySec : ${infer.latencySec.toFixed(2)}`);
  console.log(`status     : ${infer.status}`);
  console.log(`finishReason: ${infer.result?.finishReason ?? "(null result)"}`);
  console.log(`toolCalls  : ${infer.result?.pendingToolCalls.length ?? 0}`);
  if (infer.result?.pendingToolCalls[0]) console.log(`calldata[0]: ${infer.result.pendingToolCalls[0].slice(0, 50)}...`);

  const ok = infer.status === 2 && infer.latencySec < 15;
  console.log(`\n${ok ? "✅ FIXED: result via poll in <15s" : "❌ still slow/failed"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

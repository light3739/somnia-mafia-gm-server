/** Measure inferChat (the voting/day-chat path) latency: one isolated call, then
 * a burst of 3 concurrent calls (mimics 3 agents voting at once). Read cost ~0.24
 * SOMI per call. Run: npx tsx src/scripts/probe-chat-latency.ts */
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inferChatOnSomnia } from "../agents/llm-chat-call.js";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

function strip(pk: string | undefined): Hex {
  const m = pk?.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
  if (!m) throw new Error("AGENT_SPONSOR_PRIVATE_KEY missing");
  return (m[0].startsWith("0x") ? m[0] : `0x${m[0]}`) as Hex;
}

const req = {
  roles: ["system", "user"],
  messages: [
    "You are playing Mafia. Vote to eliminate one suspect. Reply with one short sentence.",
    "Alive: Alice, Bob, Carol. Who do you vote for and why?",
  ],
  chainOfThought: false,
};

async function main() {
  const sponsor = privateKeyToAccount(strip(process.env.AGENT_SPONSOR_PRIVATE_KEY));
  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });
  const walletClient = createWalletClient({ account: sponsor, chain: somniaTestnet, transport: http() });
  const opts = { publicClient, walletClient, chainId: 50312, waitMs: 60_000 } as const;

  console.log("=== single isolated inferChat ===");
  const a = await inferChatOnSomnia(req, opts);
  console.log(`  latencySec=${a.latencySec.toFixed(2)} status=${a.status} resp="${(a.result?.response ?? "(null)").slice(0, 40)}"`);

  // Note: all 3 from the SAME wallet → createRequests serialize on nonce, which
  // is itself informative (in-game each agent has its OWN wallet, so they don't
  // nonce-block each other, but they DO hit the subcommittee concurrently).
  console.log("\n=== burst: 3 concurrent inferChat (same wallet) ===");
  const t0 = Date.now();
  const results = await Promise.all([
    inferChatOnSomnia(req, opts),
    inferChatOnSomnia(req, opts),
    inferChatOnSomnia(req, opts),
  ]);
  console.log(`  wall=${((Date.now() - t0) / 1000).toFixed(2)}s`);
  results.forEach((r, i) =>
    console.log(`  [${i}] latencySec=${r.latencySec.toFixed(2)} status=${r.status}`)
  );
}
main().catch((e) => { console.error(e); process.exit(1); });

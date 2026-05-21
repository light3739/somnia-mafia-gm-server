/**
 * Operational helper — top up agent EOAs from the sponsor wallet.
 *
 * fill-room funds agents with only a small gas reserve; a full game (pre-game
 * gas + LLM inference deposits for chat/vote/night, ~0.24 STT/call) needs more.
 * This tops up specific agents on demand.
 *
 * Run:
 *   cd somnia-mafia-gm-server
 *   npx tsx src/scripts/topup-agents.ts <amountSTT> <agentAddr> [agentAddr...]
 *
 * Note: don't run while a fill-room is in flight (shared sponsor nonce).
 */
import "dotenv/config";
import { parseEther, formatEther, type Address } from "viem";
import { topUp, getSponsorAddress, getSponsorBalance } from "../agents/sponsor.js";

const CHAIN_ID = Number(process.env.SMOKE_CHAIN_ID ?? "50312");

async function main() {
  const [amtStr, ...addrs] = process.argv.slice(2);
  if (!amtStr || addrs.length === 0) {
    throw new Error("usage: tsx src/scripts/topup-agents.ts <amountSTT> <agentAddr> [agentAddr...]");
  }
  const amount = parseEther(amtStr);
  console.log(`sponsor ${getSponsorAddress()} = ${formatEther(await getSponsorBalance(CHAIN_ID))} STT`);
  console.log(`topping up ${addrs.length} agent(s) +${amtStr} STT each on chain ${CHAIN_ID}...`);
  for (const a of addrs) {
    const hash = await topUp(CHAIN_ID, a as Address, amount, { waitForReceipt: true });
    console.log(`  ${a} +${amtStr} STT  tx=${hash}`);
  }
  console.log(`sponsor after = ${formatEther(await getSponsorBalance(CHAIN_ID))} STT`);
  console.log("done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

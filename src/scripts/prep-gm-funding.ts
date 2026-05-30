/**
 * Operational helper — ensure the GM wallet holds STT before an agent game.
 *
 * The sponsor funds the HD agent EOAs, but NOT the GM wallet. The GM wallet
 * pays gas for registerAgent + resolveNightAsGameMaster, so an empty GM wallet
 * makes agent fills/night-resolution revert. This prints GM + sponsor balances
 * and tops the GM wallet up from the sponsor when it is below the floor.
 *
 * Run:
 *   cd somnia-mafia-gm-server
 *   npx tsx src/scripts/prep-gm-funding.ts
 */
import "dotenv/config";
import { parseEther, formatEther, type Address } from "viem";
import { getChainConfig } from "../chain.js";
import { topUp, getSponsorAddress, getSponsorBalance } from "../agents/sponsor.js";

const CHAIN_ID = Number(process.env.SMOKE_CHAIN_ID ?? "50312");
const MIN_GM_STT = Number(process.env.GM_MIN_STT ?? "5");
const TOPUP_GM_STT = process.env.GM_TOPUP_STT ?? "12";

async function main() {
  const { public: publicClient, wallet: gmWallet } = getChainConfig(CHAIN_ID);
  const gmAddr = (gmWallet as any).account.address as Address;
  const sponsorAddr = getSponsorAddress();
  const sponsorBal = await getSponsorBalance(CHAIN_ID);
  const gmBal = await publicClient.getBalance({ address: gmAddr });
  console.log(`chain   ${CHAIN_ID}`);
  console.log(`sponsor ${sponsorAddr} = ${formatEther(sponsorBal)} STT`);
  console.log(`GM      ${gmAddr} = ${formatEther(gmBal)} STT`);

  if (gmBal < parseEther(String(MIN_GM_STT))) {
    console.log(`GM below ${MIN_GM_STT} STT → topUp +${TOPUP_GM_STT} STT from sponsor...`);
    const hash = await topUp(CHAIN_ID, gmAddr, parseEther(TOPUP_GM_STT), { waitForReceipt: true });
    console.log(`  tx=${hash}`);
    console.log(`GM after = ${formatEther(await publicClient.getBalance({ address: gmAddr }))} STT`);
  } else {
    console.log(`GM funded enough (>=${MIN_GM_STT} STT) — no topup.`);
  }
  console.log("done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

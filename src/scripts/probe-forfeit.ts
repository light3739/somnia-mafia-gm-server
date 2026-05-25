/** End a stuck room via forfeitGame from alive agent wallets. The room's agents
 * committed keccak role hashes (pre-fix) so endGameZK can never verify — forfeit
 * is the only way to close it. Run: npx tsx src/scripts/probe-forfeit.ts <roomId> */
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, http, parseGwei, parseAbi, type Address } from "viem";
import { deriveAgentWallets } from "../agents/wallets.js";

const somniaTestnet = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});
const DIAMOND = "0x031b6746155ce11c7b533935f4674f5fc4682338" as Address;
const ABI = parseAbi([
  "function forfeitGame(uint256 roomId) payable",
  "function getRoom(uint256) view returns ((uint64 id, address host, string name, uint8 phase, uint8 maxPlayers, uint8 playersCount, uint8 aliveCount, uint16 dayCount, uint8 currentShufflerIndex, uint32 lastActionTimestamp, uint32 phaseDeadline, uint8 confirmedCount, uint8 votedCount, uint8 committedCount, uint8 revealedCount, uint8 keysSharedCount, uint128 depositPool, uint128 depositPerPlayer, bool isPrivate, uint256 tournamentId))",
  "function getPlayers(uint256) view returns ((address wallet, string nickname, bytes publicKey, uint32 flags)[])",
]);

async function main() {
  const roomId = BigInt(process.argv[2] ?? "0");
  const mnemonic = process.env.AGENT_MASTER_MNEMONIC;
  if (!mnemonic) throw new Error("AGENT_MASTER_MNEMONIC missing");
  const pc = createPublicClient({ chain: somniaTestnet, transport: http() });

  const players = (await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getPlayers", args: [roomId] })) as any[];
  const aliveSet = new Set(players.filter((p) => Number(p.flags) & 0x2).map((p) => p.wallet.toLowerCase()));
  const wallets = deriveAgentWallets(mnemonic, roomId, 6);

  const phaseBefore = (await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRoom", args: [roomId] })) as any;
  console.log(`room ${roomId} phase before=${phaseBefore.phase} alive=${phaseBefore.aliveCount}`);

  for (const w of wallets) {
    if (!aliveSet.has(w.address.toLowerCase())) continue;
    const wc = createWalletClient({ account: w.account, chain: somniaTestnet, transport: http() });
    try {
      const hash = await wc.writeContract({ address: DIAMOND, abi: ABI, functionName: "forfeitGame", args: [roomId], gasPrice: parseGwei("10") });
      const r = await pc.waitForTransactionReceipt({ hash });
      console.log(`forfeit from ${w.address}: ${r.status} (${hash})`);
    } catch (e: any) {
      console.log(`forfeit from ${w.address} FAILED: ${e.shortMessage ?? e.message}`);
    }
    const room = (await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRoom", args: [roomId] })) as any;
    console.log(`  → room phase=${room.phase} alive=${room.aliveCount}`);
    if (Number(room.phase) === 0 || Number(room.aliveCount) <= 1) { console.log("room ended/reset."); break; }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

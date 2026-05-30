/**
 * Debug: exact cause of the missing DAY death-reaction.
 * A) Real on-chain logIndex order of NightResolvedByGM vs DayStarted in the
 *    kill block (= the order viem delivers = the order logListener writes room:logs).
 * B) Synthetic parse proof: does latestNightDeath flip with that ordering?
 *   npx tsx src/scripts/debug-deathcause.ts [killBlock]
 */
import "dotenv/config";
import { createPublicClient, http, decodeEventLog, type Hex } from "viem";
import { DIAMOND_ABI } from "../abi.js";
import { loadPublicGameContext } from "../agents/strategic-context.js";

const rpc = process.env.SOMNIA_RPC_URL!;
const diamond = process.env.SOMNIA_DIAMOND as Hex;
const ROOM = "71";
const KILL = "0xE78Afbaccec4c9b4eBAC8c26BA485E7CB988C7a2"; // Agent #3, killed N2
const block = BigInt(process.argv[2] ?? "396076050");
const client = createPublicClient({ transport: http(rpc) });

console.log(`=== A) real on-chain order at block ${block} (diamond ${diamond}) ===`);
const logs = await client.getLogs({ address: diamond, fromBlock: block, toBlock: block });
const rows = logs
  .map((l) => {
    let name = "?";
    let room = "";
    try {
      const d = decodeEventLog({ abi: DIAMOND_ABI as any, topics: l.topics, data: l.data });
      name = d.eventName as string;
      room = (d.args as any)?.roomId?.toString?.() ?? "";
    } catch {
      /* non-diamond-abi log */
    }
    return { logIndex: Number(l.logIndex), name, room };
  })
  .sort((a, b) => a.logIndex - b.logIndex);
for (const r of rows) console.log(`  logIndex ${r.logIndex}: ${r.name}${r.room ? ` (room ${r.room})` : ""}`);

const room71 = rows.filter((r) => r.room === ROOM);
const killIdx = room71.find((r) => r.name === "NightResolvedByGM")?.logIndex;
const dayIdx = room71.find((r) => r.name === "DayStarted")?.logIndex;
console.log(`\n  room ${ROOM}: NightResolvedByGM logIndex=${killIdx}, DayStarted logIndex=${dayIdx}`);
if (killIdx != null && dayIdx != null) {
  console.log(
    killIdx < dayIdx
      ? "  → kill BEFORE day → parser attributes kill to PREVIOUS day → latestNightDeath should resolve → points to MODEL (M)"
      : "  → day BEFORE kill → parser attributes kill to CURRENT day → latestBefore(<day) MISSES it → points to PARSE/ORDER bug (P)"
  );
}

console.log(`\n=== B) synthetic parse proof (loadPublicGameContext currentDay=3) ===`);
const d = (n: number) => ({ eventType: "DayStarted", eventData: { dayNumber: n } });
const peaceful = { eventType: "NIGHT_RESULT", eventData: { isSafe: true } };
const kill = { eventType: "NIGHT_RESULT", eventData: { isEliminated: true, playerAddress: KILL.toLowerCase() } };
async function run(label: string, logsArr: any[]) {
  const fake = { get: async () => JSON.stringify(logsArr) } as any;
  const ctx = await loadPublicGameContext(fake, {
    chainId: 50312,
    roomId: ROOM,
    currentDay: 3,
    alive: [KILL as Hex],
    startingActive: 6,
  });
  console.log(`  ${label}: latestNightDeath=${ctx.latestNightDeath} peacefulHappened=${ctx.latestNightHappened}`);
}
await run("emission order (kill before DayStarted(3))", [d(1), peaceful, d(2), kill, d(3)]);
await run("mis-order (DayStarted(3) before kill)", [d(1), peaceful, d(2), d(3), kill]);
process.exit(0);

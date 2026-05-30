/**
 * Debug: why didn't the DAY death-opener fire? Dumps room:logs phase events IN
 * ORDER and runs loadPublicGameContext to see what latestNightDeath resolves to.
 *   npx tsx src/scripts/debug-night-context.ts <room> [chainId]
 */
import "dotenv/config";
import { Redis } from "ioredis";
import { loadPublicGameContext } from "../agents/strategic-context.js";

const room = process.argv[2] ?? "71";
const chainId = Number(process.argv[3] ?? "50312");
const r = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const key = `room:logs:${chainId}:${room}`;
const raw = await r.get(key);
if (!raw) {
  console.log(`NO room:logs at ${key} (expired or never written)`);
  process.exit(0);
}
const logs = JSON.parse(raw) as any[];
console.log(`room:logs total entries: ${logs.length}`);
console.log("--- phase-relevant entries IN STORED ORDER ---");
logs.forEach((l, i) => {
  if (["DayStarted", "NightStarted", "NIGHT_RESULT", "VOTING_RESULT"].includes(l.eventType)) {
    console.log(`[${i}] ${l.eventType} ${JSON.stringify(l.eventData)}`);
  }
});

for (const day of [2, 3]) {
  const ctx = await loadPublicGameContext(r as any, {
    chainId,
    roomId: room,
    currentDay: day,
    alive: [],
    startingActive: 6,
  });
  console.log(`\n=== loadPublicGameContext currentDay=${day} ===`);
  console.log("latestNightDeath   :", ctx.latestNightDeath);
  console.log("latestNightHappened:", ctx.latestNightHappened);
  console.log("latestVoteOut      :", ctx.latestVoteOut);
}
await r.quit();

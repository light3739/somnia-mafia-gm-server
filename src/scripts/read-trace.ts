/**
 * Read stored agent decision traces for a phase (debug/verify).
 *   npx tsx src/scripts/read-trace.ts <room> <phaseId> [chainId]
 *   SHOW_PROMPT=1 ... to dump the full stored prompt of each agent.
 */
import "dotenv/config";
import { Redis } from "ioredis";

const room = process.argv[2] ?? "71";
const phase = process.argv[3] ?? "D2-VOTING";
const chainId = process.argv[4] ?? "50312";
const r = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const keys = (await r.keys(`agents:trace:${chainId}:${room}:${phase}:*`)).sort();
if (keys.length === 0) console.log(`(no traces for ${phase} room ${room})`);
for (const k of keys) {
  const v = await r.get(k);
  if (!v) continue;
  let t: any;
  try {
    t = JSON.parse(v);
  } catch {
    console.log(k, "(unparseable)");
    continue;
  }
  console.log(`\n===== ${phase} ${k.split(":").pop()} =====`);
  console.log(`target=${t.target}  source=${t.source}${t.fallbackReason ? ` (${t.fallbackReason})` : ""}`);
  if (t.response !== undefined) console.log("response:", JSON.stringify(t.response));
  if (process.env.SHOW_PROMPT === "1" && t.prompt) console.log("--- PROMPT ---\n" + t.prompt + "\n--- END PROMPT ---");
}
await r.quit();

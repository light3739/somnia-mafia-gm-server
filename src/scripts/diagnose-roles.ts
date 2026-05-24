/**
 * diagnose-roles.ts — read-only root-cause probe for the roles=null bug.
 *
 * On-chain part (no redis): dumps room counts + deck shape. Tells us whether
 * every player actually shuffled (revealedCount) and whether getDeck returns
 * ciphertext (expected) or plaintext (decrypted-on-chain).
 *
 * Redis part (optional, needs REDIS_URL → prod via tunnel/SSH): pulls the agent
 * keypairs (agents:sra:*) + submitted decryption keys (gm:room:*:srakey:*) and
 * peels the SRA layers slot-by-slot to identify which key/layer is inconsistent.
 *
 * Usage:  npx tsx src/scripts/diagnose-roles.ts <roomId> [chainId]
 */
import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { DIAMOND_ABI } from '../abi.js';
import { getCardOffset, modPow, SRA_PRIME, roleFromCardValue } from '../crypto/sra.js';
import { Redis } from 'ioredis';

const rpc = process.env.SOMNIA_RPC_URL!;
const diamond = process.env.SOMNIA_DIAMOND! as `0x${string}`;
const roomId = BigInt(process.argv[2] ?? '31');
const chainId = Number(process.argv[3] ?? '50312');
const PH = ['LOBBY', 'SHUFFLING', 'REVEAL', 'DAY', 'VOTING', 'NIGHT', 'ENDED'];

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}(${s.length}d)` : s);

const client = createPublicClient({ transport: http(rpc) });

const room: any = await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getRoom', args: [roomId],
});
const players: any[] = await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getPlayers', args: [roomId],
}) as any[];
const deck: string[] = await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getDeck', args: [roomId],
}) as string[];

const offset = getCardOffset(roomId);
console.log(`\n=== room ${roomId} (chain ${chainId}) ===`);
console.log(`phase=${PH[Number(room.phase)] ?? room.phase}  offset=${offset}  validRole=[${offset + 1}..${offset + 4}]`);
console.log({
  playersCount: Number(room.playersCount),
  currentShufflerIndex: Number(room.currentShufflerIndex),
  committedCount: Number(room.committedCount),
  revealedCount: Number(room.revealedCount),
  keysSharedCount: Number(room.keysSharedCount),
  confirmedCount: Number(room.confirmedCount),
  deckLength: deck.length,
});
console.log(`\nplayers (slot order):`);
players.forEach((p, i) => {
  console.log(`  [${i}] ${p.wallet} flags=${Number(p.flags)} deck[${i}]=${deck[i] ? short(deck[i]) : 'MISSING'}`);
});

// ── Redis peel (optional) ──
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.log(`\n[no REDIS_URL set — skipping key-peel. On-chain structural dump only.]`);
  console.log(`Set REDIS_URL=redis://127.0.0.1:<tunnelport> to peel layers.`);
  process.exit(0);
}

const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
const r = String(roomId);

// agent keypairs (e,d) live 30d; submitted d's live 48h.
const agentKp = new Map<string, { e: bigint; d: bigint }>();
const submittedD = new Map<string, bigint>();
for (const p of players) {
  const a = p.wallet.toLowerCase();
  const kpRaw = await redis.get(`agents:sra:${chainId}:${r}:${a}`);
  if (kpRaw) { try { const { e, d } = JSON.parse(kpRaw); agentKp.set(a, { e: BigInt(e), d: BigInt(d) }); } catch {} }
  const sub = await redis.get(`gm:room:${chainId}:${r}:srakey:${a}`);
  if (sub) submittedD.set(a, BigInt(sub));
}

console.log(`\n=== keys ===`);
players.forEach((p) => {
  const a = p.wallet.toLowerCase();
  const isAgent = agentKp.has(a);
  console.log(`  ${a} ${isAgent ? 'AGENT(e,d kp)' : 'HUMAN '} submittedD=${submittedD.has(a) ? 'yes' : 'MISSING'}`);
});

// Verify each submitted d inverts its own e (agents only — we hold their e).
console.log(`\n=== per-key self-consistency (submitted d vs known e) ===`);
const probe = BigInt(offset + 1); // a valid card value
for (const p of players) {
  const a = p.wallet.toLowerCase();
  const kp = agentKp.get(a);
  const sd = submittedD.get(a);
  if (kp && sd !== undefined) {
    const round = modPow(modPow(probe, kp.e, SRA_PRIME), sd, SRA_PRIME);
    const matchKp = sd === kp.d;
    console.log(`  ${a} AGENT submittedD==kp.d? ${matchKp}  roundtrip(enc->submittedD)==plain? ${round === probe}`);
  } else if (sd !== undefined) {
    console.log(`  ${a} HUMAN  submittedD present (cannot self-check — no e held)`);
  }
}

// Peel layers per slot: apply ALL submitted d's (what the GM does), and also
// try peeling only the AGENT d's to see what's left (should be m^human_e).
console.log(`\n=== slot decode ===`);
const allD = players.map((p) => submittedD.get(p.wallet.toLowerCase())).filter((x): x is bigint => x !== undefined);
const agentD = players.map((p) => agentKp.get(p.wallet.toLowerCase())?.d).filter((x): x is bigint => x !== undefined);
players.forEach((p, i) => {
  const c = deck[i];
  if (!c) { console.log(`  [${i}] no deck slot`); return; }
  // GM path: apply every submitted d.
  let vAll = BigInt(c);
  for (const d of allD) vAll = modPow(vAll, d, SRA_PRIME);
  const roleAll = roleFromCardValue(vAll.toString(), roomId);
  // Peel only agent layers.
  let vAgentsPeeled = BigInt(c);
  for (const d of agentD) vAgentsPeeled = modPow(vAgentsPeeled, d, SRA_PRIME);
  const peeledIsRole = Number(vAgentsPeeled - BigInt(offset));
  console.log(`  [${i}] GM-decode=${short(vAll.toString())} role=${roleAll}  | agentsPeeled=${short(vAgentsPeeled.toString())} (minus offset=${peeledIsRole >= 0 && peeledIsRole < 100 ? peeledIsRole : 'big'})`);
});

console.log(`\nINTERPRETATION:`);
console.log(`  • agentsPeeled minus offset == 1..4  → human layer NOT in deck (human never encrypted). Root cause: deck missing human layer; GM applies human d → corrupts.`);
console.log(`  • agentsPeeled is big AND GM-decode role!=NONE → fine (no bug).`);
console.log(`  • agentsPeeled is big AND GM-decode role==NONE → wrong human d submitted (key mismatch).`);
await redis.quit();

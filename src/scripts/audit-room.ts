/**
 * audit-room.ts — Post-game forensic audit of an agent game, on-chain only.
 *
 * Recovers each agent's PRIVATE night/vote decisions by brute-forcing the
 * UNSALTED actionHash committed in AgentInferenceCommitted, and cross-checks
 * against public VoteCast / VotingFinalized / PlayerEliminated / message
 * commits. See memory `agent-decision-audit`.
 *
 * Usage:  npx tsx src/scripts/audit-room.ts <roomId> [maxBackChunks]
 */
import 'dotenv/config';
import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
  pad,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { DIAMOND_ABI } from '../abi.js';
import { AGENT_REGISTRY_ABI, DIAMOND_VOTE_ABI } from '../agents/registry-abi.js';

const rpc = process.env.SOMNIA_RPC_URL!;
const diamond = process.env.SOMNIA_DIAMOND! as Address;
const roomId = BigInt(process.argv[2] ?? '0');
const MAX_BACK_CHUNKS = Number(process.argv[3] ?? 120);
const CHUNK = 1000n; // dream-rpc hard limit: 1000 blocks/getLogs

if (roomId === 0n) {
  console.error('usage: npx tsx src/scripts/audit-room.ts <roomId>');
  process.exit(1);
}

const client = createPublicClient({ transport: http(rpc) });
const PH = ['LOBBY', 'SHUFFLING', 'REVEAL', 'DAY', 'VOTING', 'NIGHT', 'ENDED'];
const lc = (a: string) => a.toLowerCase();
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

// ---- room + players -------------------------------------------------------
const room: any = await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getRoom', args: [roomId],
});
const players = (await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getPlayers', args: [roomId],
})) as any[];
const dayCount = Number(room.dayCount);
const nick = new Map<string, string>();
const isAgentCache = new Map<string, boolean>();
for (const p of players) nick.set(lc(p.wallet), p.nickname || short(p.wallet));

// who is an agent?
for (const p of players) {
  try {
    const a: boolean = await client.readContract({
      address: diamond, abi: AGENT_REGISTRY_ABI, functionName: 'isAgent', args: [roomId, p.wallet],
    });
    isAgentCache.set(lc(p.wallet), a);
  } catch { isAgentCache.set(lc(p.wallet), false); }
}

const label = (w: string) =>
  `${nick.get(lc(w)) ?? short(w)}${isAgentCache.get(lc(w)) ? ' [AGENT]' : ' [human]'}`;

console.log(`\n=== ROOM ${roomId} === phase=${PH[Number(room.phase)] ?? room.phase} day=${dayCount} alive=${Number(room.aliveCount)}/${Number(room.playersCount)}`);
console.log('players:');
for (const p of players) console.log(`  ${lc(p.wallet)}  ${label(p.wallet)}  flags=0x${Number(p.flags).toString(16)}`);

// ---- brute-force lookup tables -------------------------------------------
const allTargets: Address[] = [
  '0x0000000000000000000000000000000000000000' as Address,
  ...players.map((p) => getAddress(p.wallet) as Address),
];
function nightTag(kind: string) {
  return kind === 'KILL' ? 'NIGHT_KILL' : kind === 'HEAL' ? 'NIGHT_HEAL'
       : kind === 'CHECK' ? 'NIGHT_CHECK' : 'NIGHT_SKIP';
}
const ah = (tag: string, target: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], [tag, target]));

const actionByHash = new Map<string, string>();
for (const t of allTargets) {
  actionByHash.set(ah('VOTE', t), `VOTE → ${t === allTargets[0] ? '(abstain/0x0)' : label(t)}`);
  for (const k of ['KILL', 'HEAL', 'CHECK', 'SKIP']) {
    actionByHash.set(ah(nightTag(k), t), `${k}${k === 'SKIP' ? '' : ' → ' + (t === allTargets[0] ? '(0x0)' : label(t))}`);
  }
}

// phaseId → "Dd-KIND"
const phaseLabel = new Map<string, string>();
for (let d = 1; d <= dayCount; d++)
  for (const k of ['DAY', 'VOTING', 'NIGHT'])
    phaseLabel.set(keccak256(toHex(`D${d}-${k}`)), `D${d}-${k}`);

// ---- find block window: GameStarted, scan backward --------------------------
const latest = await client.getBlockNumber();
const roomTopic = pad(toHex(roomId), { size: 32 }) as Hex;
let startBlock: bigint | null = null;
console.log(`\nscanning backward from block ${latest} for GameStarted(room ${roomId})…`);
for (let i = 0; i < MAX_BACK_CHUNKS && startBlock === null; i++) {
  const to = latest - BigInt(i) * CHUNK;
  const from = to - CHUNK + 1n > 0n ? to - CHUNK + 1n : 0n;
  const logs = await client.getLogs({
    address: diamond, fromBlock: from, toBlock: to,
    event: (DIAMOND_ABI as any).find((e: any) => e.type === 'event' && e.name === 'GameStarted'),
    args: { roomId },
  });
  if (logs.length) { startBlock = logs[0].blockNumber!; break; }
  if (from === 0n) break;
}
if (startBlock === null) {
  console.log('GameStarted not found in window — widening to last 8 chunks of inference events instead.');
  startBlock = latest - CHUNK * 8n;
}
console.log(`game start block ≈ ${startBlock}`);

// ---- collect all relevant logs from startBlock..latest --------------------
async function collect(eventName: string, abi: any) {
  const ev = abi.find ? abi.find((e: any) => e.type === 'event' && e.name === eventName)
                      : (abi as any[]).find((e: any) => e.type === 'event' && e.name === eventName);
  const out: any[] = [];
  for (let from = startBlock!; from <= latest; from += CHUNK) {
    const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
    const logs = await client.getLogs({ address: diamond, fromBlock: from, toBlock: to, event: ev, args: { roomId } });
    out.push(...logs);
  }
  return out;
}

const inferLogs = await collect('AgentInferenceCommitted', AGENT_REGISTRY_ABI);
const msgLogs = await collect('AgentMessageCommittedV2', AGENT_REGISTRY_ABI);
const voteLogs = await collect('VoteCast', DIAMOND_ABI);
const elimLogs = await collect('PlayerEliminated', DIAMOND_ABI);
const finalLogs = await collect('VotingFinalized', DIAMOND_ABI);
const nightResolvedLogs = await collect('NightResolvedByGM', DIAMOND_ABI);
const nightFinalizedLogs = await collect('NightFinalized', DIAMOND_ABI);
const nightStartLogs = await collect('NightStarted', DIAMOND_ABI);
const dayStartLogs = await collect('DayStarted', DIAMOND_ABI);

// ---- report ----------------------------------------------------------------
// group inference by phase
type Row = { agent: string; action: string; blk: number };
const inferByPhase = new Map<string, Row[]>();
for (const l of inferLogs) {
  const pid = (l.args.phaseId as string).toLowerCase();
  const plabel = phaseLabel.get(pid) ?? `phase ${pid.slice(0, 10)}…`;
  const action = actionByHash.get((l.args.actionHash as string)) ?? `UNKNOWN actionHash ${(l.args.actionHash as string).slice(0, 12)}…`;
  if (!inferByPhase.has(plabel)) inferByPhase.set(plabel, []);
  inferByPhase.get(plabel)!.push({ agent: l.args.agent as string, action, blk: Number(l.blockNumber) });
}
const msgByPhase = new Map<string, Set<string>>();
for (const l of msgLogs) {
  const pid = (l.args.phaseId as string).toLowerCase();
  const plabel = phaseLabel.get(pid) ?? pid.slice(0, 10);
  if (!msgByPhase.has(plabel)) msgByPhase.set(plabel, new Set());
  msgByPhase.get(plabel)!.add(lc(l.args.agent as string));
}

const agents = players.filter((p) => isAgentCache.get(lc(p.wallet))).map((p) => lc(p.wallet));

console.log(`\n=== AGENT DECISIONS (private, recovered from unsalted actionHash) ===`);
for (let d = 1; d <= dayCount; d++) {
  for (const k of ['DAY', 'VOTING', 'NIGHT']) {
    const plabel = `D${d}-${k}`;
    const rows = inferByPhase.get(plabel) ?? [];
    const spoke = msgByPhase.get(plabel) ?? new Set();
    if (k === 'DAY') {
      const missing = agents.filter((a) => !spoke.has(a));
      console.log(`\n[${plabel}] message-commits: ${spoke.size}/${agents.length} agents` +
        (missing.length ? `  ← NO commit: ${missing.map(label).join(', ')}` : ''));
      continue;
    }
    console.log(`\n[${plabel}]  inference-commits: ${rows.length}/${agents.length} agents`);
    const committed = new Set(rows.map((r) => lc(r.agent)));
    for (const r of rows) console.log(`   ${label(r.agent)}: ${r.action}  [commit blk ${r.blk}]`);
    const missing = agents.filter((a) => !committed.has(a));
    if (missing.length) console.log(`   ← NO inference commit (skipped/dropped): ${missing.map(label).join(', ')}`);
  }
}

console.log(`\n=== PUBLIC ON-CHAIN FACTS ===`);
console.log('VoteCast (who actually voted on-chain):');
for (const l of voteLogs) console.log(`   ${label(l.args.voter)} → ${l.args.target === allTargets[0] ? '(0x0)' : label(l.args.target)}  blk ${l.blockNumber}`);
console.log('VotingFinalized:');
for (const l of finalLogs) console.log(`   eliminated=${l.args.eliminated === allTargets[0] ? '(none/tie)' : label(l.args.eliminated)} votes=${Number(l.args.voteCount)}  blk ${l.blockNumber}`);
console.log('PlayerEliminated (deaths, incl. night):');
for (const l of elimLogs) console.log(`   ${label(l.args.player)} — "${l.args.reason}"  blk ${l.blockNumber}`);

console.log('\n=== NIGHT RESOLUTION (what the GM actually submitted on-chain) ===');
const phaseEvents = [
  ...dayStartLogs.map((l: any) => ({ blk: Number(l.blockNumber), kind: `DayStarted(day ${Number(l.args.dayNumber)})` })),
  ...nightStartLogs.map((l: any) => ({ blk: Number(l.blockNumber), kind: 'NightStarted' })),
  ...nightResolvedLogs.map((l: any) => ({ blk: Number(l.blockNumber), kind: `NightResolvedByGM KILL=${l.args.killed === allTargets[0] ? '(none)' : label(l.args.killed)} HEAL=${l.args.healed === allTargets[0] ? '(none)' : label(l.args.healed)}` })),
  ...nightFinalizedLogs.map((l: any) => ({ blk: Number(l.blockNumber), kind: `NightFinalized PEACEFUL (killed=0x0 healed=0x0)` })),
].sort((a, b) => a.blk - b.blk);
for (const e of phaseEvents) console.log(`   blk ${e.blk}: ${e.kind}`);
console.log(`   (NightResolvedByGM = GM submitted a kill; NightFinalized = GM submitted peaceful/no-kill)`);

console.log('\ndone.');

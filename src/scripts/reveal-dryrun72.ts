import 'dotenv/config';
import { createPublicClient, http, getAbiItem } from 'viem';
import { AGENT_REGISTRY_ABI, DIAMOND_VOTE_ABI } from '../agents/registry-abi.js';
import { buildPhaseLabelMap } from '../agents/reveal-trace.js';

const rpc = process.env.SOMNIA_RPC_URL!;
const diamond = process.env.SOMNIA_DIAMOND! as `0x${string}`;
const ROOM = BigInt(process.env.DRYRUN_ROOM || '72');
const client = createPublicClient({ transport: http(rpc) });
const committed = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: 'AgentInferenceCommitted' });
const revealed = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: 'AgentInferenceRevealed' });

const room: any = await client.readContract({
  address: diamond, abi: DIAMOND_VOTE_ABI, functionName: 'getRoom', args: [ROOM],
});
const dayCount = Number(room.dayCount);
const map = buildPhaseLabelMap(dayCount);

async function logsFor(ev: any) {
  const latest = await client.getBlockNumber();
  const out: any[] = [];
  for (let off = 0n; off < 90000n; off += 900n) {
    const to = latest > off ? latest - off : 0n;
    const from = to > 900n ? to - 900n : 0n;
    out.push(...(await client.getLogs({ address: diamond, event: ev, args: { roomId: ROOM }, fromBlock: from, toBlock: to })));
    if (to === 0n) break;
  }
  return out;
}

const c = await logsFor(committed);
const r = await logsFor(revealed);
console.log(`room ${ROOM} dayCount=${dayCount} | committed inference slots=${c.length} | already revealed=${r.length}`);

const byLabel = new Map<string, number>();
let unknown = 0;
for (const l of c) {
  const lbl = map.get(String((l as any).args.phaseId).toLowerCase());
  if (!lbl) { unknown++; continue; }
  byLabel.set(lbl, (byLabel.get(lbl) ?? 0) + 1);
}
console.log('would-reveal by phase:', Object.fromEntries(byLabel), unknown ? `| UNKNOWN=${unknown}` : '| all mapped');

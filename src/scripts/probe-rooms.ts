import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { DIAMOND_ABI } from '../abi.js';

const rpc = process.env.SOMNIA_RPC_URL!;
const diamond = process.env.SOMNIA_DIAMOND! as `0x${string}`;
const PH = ['LOBBY', 'SHUFFLING', 'REVEAL', 'DAY', 'VOTING', 'NIGHT', 'ENDED'];

const client = createPublicClient({ transport: http(rpc) });
const now = Math.floor(Date.now() / 1000);
console.log('diamond', diamond, 'now', now);

for (let id = 1; id <= 20; id++) {
  try {
    const r: any = await client.readContract({
      address: diamond, abi: DIAMOND_ABI as any, functionName: 'getRoom', args: [BigInt(id)],
    });
    const phase = Number(r.phase);
    if (phase === 0 && Number(r.playersCount) === 0) continue; // empty/never-used slot
    const dl = Number(r.phaseDeadline);
    const overdue = dl > 0 && now > dl ? `OVERDUE ${now - dl}s` : (dl > 0 ? `${dl - now}s left` : '-');
    console.log(
      `room ${id}: phase=${PH[phase] ?? phase} day=${Number(r.dayCount)} alive=${Number(r.aliveCount)}/${Number(r.playersCount)} voted=${Number(r.votedCount)} deadline=${dl} (${overdue})`
    );
  } catch (e: any) {
    // skip non-existent rooms quietly
  }
}

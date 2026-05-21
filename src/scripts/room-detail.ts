import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { DIAMOND_ABI } from '../abi.js';

const rpc = process.env.SOMNIA_RPC_URL!;
const diamond = process.env.SOMNIA_DIAMOND! as `0x${string}`;
const id = BigInt(process.argv[2] ?? '14');
const PH = ['LOBBY', 'SHUFFLING', 'REVEAL', 'DAY', 'VOTING', 'NIGHT', 'ENDED'];

const client = createPublicClient({ transport: http(rpc) });
const r: any = await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getRoom', args: [id],
});
console.log(`room ${id}: phase=${PH[Number(r.phase)] ?? r.phase}`);
console.log({
  players: `${Number(r.playersCount)} / max ${Number(r.maxPlayers)}`,
  currentShufflerIndex: Number(r.currentShufflerIndex),
  committedCount: Number(r.committedCount),
  revealedCount: Number(r.revealedCount),
  keysSharedCount: Number(r.keysSharedCount),
  confirmedCount: Number(r.confirmedCount),
});
const players: any = await client.readContract({
  address: diamond, abi: DIAMOND_ABI as any, functionName: 'getPlayers', args: [id],
});
for (const p of players) {
  console.log(`  ${p.wallet} flags=${Number(p.flags)} pubKey=${(p.publicKey ?? '0x') === '0x' || !p.publicKey ? 'NONE' : 'set'}`);
}

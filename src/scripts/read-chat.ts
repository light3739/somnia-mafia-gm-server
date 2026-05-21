import 'dotenv/config';
import { Redis } from 'ioredis';
import { agentChatLogKey } from '../agents/redis-keys.js';

const roomId = process.argv[2] ?? '18';
const chainId = Number(process.argv[3] ?? '50312');
const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const items = await r.lrange(agentChatLogKey(chainId, roomId), 0, -1);
if (items.length === 0) {
  console.log(`(no agent chat messages stored for room ${roomId})`);
} else {
  for (const it of items) {
    try {
      const m = JSON.parse(it);
      console.log(`[day ${m.day}] ${m.by}: ${m.text}`);
    } catch {
      console.log(it);
    }
  }
}
await r.quit();

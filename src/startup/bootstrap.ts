/**
 * startup/bootstrap.ts
 */
import { getRedis, loadAllState, rPersistRole } from '../redis.js';
import { getChainConfig, getPlayers, DIAMOND_ABI, FLAGS } from '../chain.js';
import { getAllNightStates, injectNightState, getNightState } from '../game-state.js';
import { sraDecryptCard, roleFromCardValue } from '../crypto/sra.js';
import { doResolveNight, nightChainIds } from '../routes/nightRoutes.js';
import type { GMStore } from '../stores/index.js';
import type { RedisClient } from '../redis.js';

const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 180_000);

export async function bootstrap(store: GMStore, redisClient: RedisClient): Promise<void> {
  if (!redisClient) return;

  await loadAllState(redisClient, {
    eciesPubkeys: store.eciesPubkeys,
    sraSKeys: store.sraSKeys,
    resolvedRoles: store.resolvedRoles,
    investigationProofs: store.investigationProofs as unknown as Map<string, Map<string, any>>,
    injectNight: injectNightState,
  });

  // Re-arm night timers
  for (const [roomIdStr, nightState] of getAllNightStates()) {
    if (!nightState.resolved) {
      const elapsed = Date.now() - nightState.nightStartedAt;
      const remaining = Math.max(5_000, NIGHT_TIMEOUT_MS - elapsed);
      const rid = BigInt(roomIdStr);
      const savedChainId = nightChainIds.get(roomIdStr);
      setTimeout(() => {
        const s = getNightState(rid);
        if (s && !s.resolved) {
          doResolveNight(rid, store, redisClient, savedChainId).catch(() => {});
        }
      }, remaining);
    }
  }

  // Restore session cache
  try {
    const sessionKeys: string[] = [];
    const stream = redisClient.scanStream({ match: 'gm:session:*', count: 200 });
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => sessionKeys.push(...batch));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (sessionKeys.length > 0) {
      for (const key of sessionKeys) {
        const val = await redisClient.get(key);
        if (val) {
          const data = JSON.parse(val);
          const wallet = key.replace('gm:session:', '');
          store.sessionCache.set(wallet, { sessionAddress: data.sessionAddress, roomId: data.roomId });
        }
      }
    }
  } catch { /* ... */ }

  // Role re-compute
  for (const [roomId, keyMap] of store.sraSKeys) {
    if (store.resolvedRoles.has(roomId)) continue;
    (async () => {
      try {
        const rid = BigInt(roomId);
        const players = await getPlayers(rid) as any[];
        const activeAddrs = players.filter(p => !!(Number(p.flags) & FLAGS.ACTIVE)).map(p => p.wallet.toLowerCase());
        if (!activeAddrs.every(a => keyMap.has(a))) return;

        const { public: pc, diamond } = getChainConfig();
        const deck = await pc.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [rid] }) as string[];
        const order = players.map(p => p.wallet.toLowerCase());
        store.roomPlayerOrder.set(roomId, order);
        const allKeys = players.map(p => keyMap.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
        const roomRoles = store.getRoomMap(store.resolvedRoles, roomId);
        order.forEach((addr, i) => {
          if (i < deck.length) {
            const r = roleFromCardValue(sraDecryptCard(deck[i], allKeys), Number(roomId));
            roomRoles.set(addr, r);
            rPersistRole(redisClient, roomId, addr, r);
          }
        });
      } catch { /* ... */ }
    })();
  }
}

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
    roomChains: store.roomChains,
    injectNight: injectNightState,
  });

  // Re-arm night timers
  for (const [roomIdStr, nightState] of getAllNightStates()) {
    if (!nightState.resolved) {
      const elapsed = Date.now() - nightState.nightStartedAt;
      const remaining = Math.max(5_000, NIGHT_TIMEOUT_MS - elapsed);
      const rid = BigInt(roomIdStr);
      const cid = nightState.chainId;
      setTimeout(() => {
        const s = getNightState(rid);
        if (s && !s.resolved) {
          doResolveNight(rid, store, redisClient, cid).catch(() => {});
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
          const walletWithChain = key.replace('gm:session:', ''); // format: 'chainId:wallet'
          const [cidStr, ...walletParts] = walletWithChain.split(':');
          const cacheKey = walletWithChain;
          const normalizedSession = data.sessionAddress;
          const roomKeyStr = String(data.roomId);
          store.sessionCache.set(cacheKey, {
            sessionAddress: normalizedSession,
            roomId: roomKeyStr,
            chainId: Number(cidStr || data.chainId || 43113),
          });
        }
      }
    }
  } catch { /* ... */ }

  // Role re-compute
  for (const [roomId, keyMap] of store.sraSKeys) {
    if (store.resolvedRoles.has(roomId)) continue;

    (async () => {
      try {
        const [cidStr, ridInKeyStr] = roomId.split(':');
        const cidNum = Number(cidStr || 43113);
        const rid = BigInt(ridInKeyStr);

        const players = await getPlayers(rid, cidNum) as any[];
        const activeAddrs = players.filter(p => !!(Number(p.flags) & FLAGS.ACTIVE)).map(p => p.wallet.toLowerCase());
        if (!activeAddrs.every(a => keyMap.has(a))) return;

        const { public: pc, diamond } = getChainConfig(cidNum);
        const ridInKey = ridInKeyStr;
        const deck = await pc.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [BigInt(ridInKey)] }) as string[];
        const order = players.map(p => p.wallet.toLowerCase());
        store.roomPlayerOrder.set(roomId, order);
        const allKeys = players.map(p => keyMap.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
        const roomRoles = store.getRoomMap(store.resolvedRoles, roomId);
        order.forEach((addr, i) => {
          if (i < deck.length) {
            const r = roleFromCardValue(sraDecryptCard(deck[i], allKeys), ridInKey);
            roomRoles.set(addr, r);
            rPersistRole(redisClient, cidNum, ridInKey, addr, r);
          }
        });
      } catch { /* ... */ }
    })();
  }
}

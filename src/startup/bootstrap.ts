/**
 * startup/bootstrap.ts
 * All Redis state restoration and night timer rehydration.
 * Called once from index.ts before app.listen().
 */
import {
  eciesPubkeys, sraSKeys, resolvedRoles, roomPlayerOrder,
  investigationProofs, sessionCache, getRoomMap,
} from '../stores/index.js';
import { getRedis, loadAllState, rPersistRole } from '../redis.js';
import { getChainConfig, getPlayers, DIAMOND_ABI, FLAGS } from '../chain.js';
import { getAllNightStates, injectNightState, getNightState } from '../game-state.js';
import { sraDecryptCard, roleFromCardValue } from '../crypto/sra.js';
import { doResolveNight, scheduleNightTimeout, nightChainIds } from '../routes/nightRoutes.js';

const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 180_000);

export async function bootstrap(): Promise<void> {
  const redisClient = getRedis();
  if (!redisClient) return;

  await loadAllState(redisClient, {
    eciesPubkeys,
    sraSKeys,
    resolvedRoles,
    investigationProofs: investigationProofs as unknown as Map<string, Map<string, any>>,
    injectNight: injectNightState,
  });

  // ── Re-arm night timers ─────────────────────────────────
  for (const [roomIdStr, nightState] of getAllNightStates()) {
    if (!nightState.resolved) {
      const elapsed = Date.now() - nightState.nightStartedAt;
      const remaining = Math.max(5_000, NIGHT_TIMEOUT_MS - elapsed);
      const rid = BigInt(roomIdStr);
      const savedChainId = nightChainIds.get(roomIdStr);
      const t = setTimeout(async () => {
        const s = getNightState(rid);
        if (!s || s.resolved) return;
        console.log(`[night-timeout] Room ${rid}: post-restart timeout — auto-resolving`);
        doResolveNight(rid, savedChainId).catch((e: any) =>
          console.error(`[night-timeout] Room ${rid}: auto-resolve failed: ${e.message}`),
        );
      }, remaining);
      // Store timer reference so it can be cleared later
      (nightChainIds as any).__timers ??= new Map();
      (nightChainIds as any).__timers.set(roomIdStr, t);
      console.log(`[startup] Room ${roomIdStr}: night in progress — timeout in ${remaining}ms`);
    }
  }

  // ── Restore session cache ───────────────────────────────
  try {
    const sessionKeys: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = redisClient.scanStream({ match: 'gm:session:*', count: 200 });
      stream.on('data', (batch: string[]) => sessionKeys.push(...batch));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (sessionKeys.length > 0) {
      const pipeline = redisClient.pipeline();
      for (const key of sessionKeys) pipeline.get(key);
      const results = await pipeline.exec();
      let restored = 0;
      for (let i = 0; i < sessionKeys.length; i++) {
        const val = results?.[i]?.[1] as string | null;
        if (!val) continue;
        try {
          const data = JSON.parse(val);
          const mainWallet = sessionKeys[i].replace('gm:session:', '');
          sessionCache.set(mainWallet, { sessionAddress: data.sessionAddress, roomId: data.roomId });
          restored++;
        } catch { /* ignore */ }
      }
      if (restored > 0) console.log(`[redis] Restored ${restored} session cache entries`);
    }
  } catch (e: any) {
    console.warn('[redis] Failed to restore session cache:', e.message);
  }

  // ── Recompute roles for rooms missing them ──────────────
  for (const [roomId, keyMap] of sraSKeys) {
    const existingRoles = resolvedRoles.get(roomId);
    if (existingRoles && existingRoles.size > 0) continue;

    console.log(`[startup] Room ${roomId}: ${keyMap.size} SRA keys found, roles missing — scheduling recompute`);
    (async () => {
      try {
        const rid = BigInt(roomId);
        const players = await getPlayers(rid) as any[];
        const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
        const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
        const missingKeys = activeAddrs.filter((addr: string) => !keyMap.has(addr));
        if (missingKeys.length > 0) return;

        const { public: publicClient, diamond } = getChainConfig();
        const deck = await publicClient.readContract({
          address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [rid],
        }) as string[];

        const order = players.map((p: any) => p.wallet.toLowerCase());
        roomPlayerOrder.set(roomId, order);

        const allKeys = players.map((p: any) => keyMap.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
        const roomRoles = getRoomMap(resolvedRoles, roomId);
        order.forEach((addr: string, i: number) => {
          if (i < deck.length) {
            const role = roleFromCardValue(sraDecryptCard(deck[i], allKeys), Number(roomId));
            roomRoles.set(addr, role);
            rPersistRole(getRedis(), roomId, addr, role);
          }
        });
        console.log(`[startup] Room ${roomId}: roles recomputed (${roomRoles.size} players)`);
      } catch (e: any) {
        console.warn(`[startup] Room ${roomId}: role recompute failed: ${e.message}`);
      }
    })();
  }
}

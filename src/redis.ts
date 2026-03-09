/**
 * redis.ts
 *
 * Optional Redis persistence layer for GM server state.
 * Falls back gracefully to in-memory if REDIS_URL is unavailable.
 *
 * Key namespace:
 *   gm:room:{roomId}:pubkey:{addr}   → ECIES pubkey string
 *   gm:room:{roomId}:srakey:{addr}   → SRA decryption key string
 *   gm:room:{roomId}:role:{addr}     → resolved role string
 *   gm:room:{roomId}:proof:{addr}    → JSON InvestigationProof
 *   gm:room:{roomId}:night           → JSON serialized RoomNightState
 *
 * TTL: 48h — enough for a long tournament session.
 */
import Redis from 'ioredis';
import type { RoomNightState, NightAction } from './game-state.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const TTL = 48 * 60 * 60; // 48 hours in seconds

export type RedisClient = Redis | null;

let _redis: RedisClient = null;

export function getRedis(): RedisClient {
  return _redis;
}

export async function connectRedis(): Promise<void> {
  try {
    const client = new Redis(REDIS_URL, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    await client.ping();
    _redis = client;
    console.log(`[redis] Connected: ${REDIS_URL}`);
  } catch (e: any) {
    console.warn(`[redis] Unavailable (${e.message}) — using in-memory state only`);
    _redis = null;
  }
}

// ─── Key builders ─────────────────────────────────────────
const K = {
  pubkey: (r: string, a: string) => `gm:room:${r}:pubkey:${a}`,
  srakey: (r: string, a: string) => `gm:room:${r}:srakey:${a}`,
  role:   (r: string, a: string) => `gm:room:${r}:role:${a}`,
  proof:  (r: string, a: string) => `gm:room:${r}:proof:${a}`,
  night:  (r: string)             => `gm:room:${r}:night`,
};

// ─── Fire-and-forget write helper ────────────────────────
function fw(redis: RedisClient, fn: (r: Redis) => Promise<unknown>): void {
  if (!redis) return;
  fn(redis).catch((e: any) => console.error('[redis] write error:', e.message));
}

// ─── Per-entry write helpers ─────────────────────────────

export function rPersistPubkey(redis: RedisClient, roomId: string, addr: string, pubkey: string): void {
  fw(redis, r => r.set(K.pubkey(roomId, addr), pubkey, 'EX', TTL));
}

export function rPersistSraKey(redis: RedisClient, roomId: string, addr: string, key: string): void {
  fw(redis, r => r.set(K.srakey(roomId, addr), key, 'EX', TTL));
}

export function rPersistRole(redis: RedisClient, roomId: string, addr: string, role: string): void {
  fw(redis, r => r.set(K.role(roomId, addr), role, 'EX', TTL));
}

export interface PersistedProof {
  targetAddress: string;
  timestamp: number;
}

export function rPersistProof(
  redis: RedisClient,
  roomId: string,
  detective: string,
  proof: PersistedProof,
): void {
  fw(redis, r => r.set(K.proof(roomId, detective), JSON.stringify(proof), 'EX', TTL));
}

export function rPersistNightState(redis: RedisClient, roomId: string, state: RoomNightState): void {
  const payload = JSON.stringify({
    roomId,
    resolved: state.resolved,
    nightStartedAt: state.nightStartedAt,
    actions: [...state.actions.entries()],
  });
  fw(redis, r => r.set(K.night(roomId), payload, 'EX', TTL));
}

export function rDeleteNightState(redis: RedisClient, roomId: string): void {
  fw(redis, r => r.del(K.night(roomId)));
}

// ─── Startup: restore all state from Redis ────────────────

export interface StateContainers {
  eciesPubkeys: Map<string, Map<string, string>>;
  sraSKeys: Map<string, Map<string, string>>;
  resolvedRoles: Map<string, Map<string, string>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  investigationProofs: Map<string, Map<string, any>>;
  injectNight: (roomId: bigint, state: RoomNightState) => void;
}

function getOrCreateInner<V>(outer: Map<string, Map<string, V>>, roomId: string): Map<string, V> {
  let m = outer.get(roomId);
  if (!m) { m = new Map(); outer.set(roomId, m); }
  return m;
}

export async function loadAllState(redis: Redis, containers: StateContainers): Promise<void> {
  const keys: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = redis.scanStream({ match: 'gm:room:*', count: 200 });
    stream.on('data', (batch: string[]) => keys.push(...batch));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (keys.length === 0) {
    console.log('[redis] No persisted GM state found');
    return;
  }

  // Batch GET all keys in one pipeline round-trip
  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.get(key);
  const results = await pipeline.exec();

  let count = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const val = results?.[i]?.[1] as string | null;
    if (!val) continue;

    // key format: gm:room:{roomId}:{type}[:{addr}]
    const parts = key.split(':');
    if (parts.length < 4) continue;

    const roomId = parts[2];
    const type   = parts[3];
    const addr   = parts[4]; // undefined for 'night'

    switch (type) {
      case 'pubkey':
        if (addr) getOrCreateInner(containers.eciesPubkeys, roomId).set(addr, val);
        break;
      case 'srakey':
        if (addr) getOrCreateInner(containers.sraSKeys, roomId).set(addr, val);
        break;
      case 'role':
        if (addr) getOrCreateInner(containers.resolvedRoles, roomId).set(addr, val);
        break;
      case 'proof': {
        if (!addr) break;
        const proof = JSON.parse(val) as PersistedProof;
        getOrCreateInner(containers.investigationProofs, roomId).set(addr, proof);
        break;
      }
      case 'night': {
        const ns = JSON.parse(val);
        const state: RoomNightState = {
          roomId: BigInt(ns.roomId),
          resolved: ns.resolved,
          nightStartedAt: ns.nightStartedAt,
          actions: new Map(ns.actions as [string, NightAction][]),
        };
        containers.injectNight(BigInt(ns.roomId), state);
        break;
      }
      default:
        continue;
    }
    count++;
  }

  console.log(`[redis] Restored ${count} state entries (${keys.length} keys scanned)`);
}

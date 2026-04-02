import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';

/**
 * Standard Redis client (works with RedisLabs, Upstash, etc. via connection string)
 */
const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
        connectTimeout: 5000, // 5 seconds
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
            if (times > 3) return null; // stop retrying after 3 times to prevent hangs
            return Math.min(times * 100, 1000);
        }
    })
    : null;

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_INSECURE_MEMORY_FALLBACK = process.env.ALLOW_INSECURE_MEMORY_FALLBACK === 'true';
const FAIL_CLOSED_SECURITY_STORAGE = IS_PRODUCTION && !ALLOW_INSECURE_MEMORY_FALLBACK;

if (redis) {
    redis.on('error', (err: any) => logger.error({ err }, '[ServerStore] Redis Connection Error'));
}

/**
 * Memory Fallback (for local development without Redis)
 */
const memoryStore: Record<string, Record<string, string>> = {};

// FIX #25: Warn loudly if memoryStore is used in production
if (!redis && process.env.NODE_ENV === 'production') {
    logger.fatal(
        '\n\n🚨🚨🚨 [ServerStore] CRITICAL: Redis is NOT configured in PRODUCTION!\n' +
        'Security-critical storage is now FAIL-CLOSED (no insecure memory fallback).\n' +
        'Set REDIS_URL (or ALLOW_INSECURE_MEMORY_FALLBACK=true for emergency only).\n🚨🚨🚨\n'
    );
}

/**
 * Global expiration for game data (24 hours)
 */
const GAME_DATA_TTL = 86400;
const REPLAY_NONCE_TTL_SECONDS = 180;

export interface PlayerSecret {
    role: number;
    salt: string;
    commitment: string;
}

export type StoreSecretResult =
    | { status: 'stored' }
    | { status: 'exists_same' }
    | { status: 'conflict'; existingRole: number };

/**
 * ServerStore: Secure storage for player secrets using Redis.
 * This ensures win-conditions can be checked even if players go offline.
 */
export class ServerStore {
    private static ensureSecureStorageForCriticalPath(operation: string): void {
        if (!redis && FAIL_CLOSED_SECURITY_STORAGE) {
            // Discussion actions are less critical than payouts/secrets.
            // If it's a discussion-related nonce being consumed, we can allow memory fallback for testing.
            if (operation.includes('Discussion')) return;

            throw new Error(`[ServerStore] ${operation} requires REDIS_URL in production. Set ALLOW_INSECURE_MEMORY_FALLBACK=true to bypass.`);
        }
    }

    /**
     * Consume one-time replay nonce for signed actions.
     * Returns true if nonce was accepted first time, false if already used.
     */
    static async consumeReplayNonce(
        scope: string,
        roomId: string,
        actorAddress: string,
        nonce: string,
        ttlSeconds: number = REPLAY_NONCE_TTL_SECONDS,
        chainId?: number | string
    ): Promise<boolean> {
        // Relax restriction for discussion to prevent 502/500 if Redis is missing
        const isDiscussion = scope.includes('discussion');
        this.ensureSecureStorageForCriticalPath(isDiscussion ? 'consumeReplayNonce:Discussion' : 'consumeReplayNonce');

        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `replay:${scope}:${cid}:${normalizedRoomId}:${actorAddress.toLowerCase()}:${nonce}`;

        if (!redis) {
            const now = Date.now();
            const fallbackBucketKey = '__replay_nonce__';
            if (!memoryStore[fallbackBucketKey]) memoryStore[fallbackBucketKey] = {};

            // Best-effort cleanup
            for (const [nonceKey, expiryStr] of Object.entries(memoryStore[fallbackBucketKey])) {
                const expiry = Number(expiryStr);
                if (!Number.isFinite(expiry) || expiry <= now) {
                    delete memoryStore[fallbackBucketKey][nonceKey];
                }
            }

            if (memoryStore[fallbackBucketKey][key]) return false;
            memoryStore[fallbackBucketKey][key] = String(now + ttlSeconds * 1000);
            return true;
        }

        try {
            const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
            return result === 'OK';
        } catch (e) {
            logger.error({ err: e }, '[ServerStore] Redis error (consumeReplayNonce)');
            return false;
        }
    }

    /**
     * Stores a player's role and salt in Redis.
     * Uses a Hash structure: room:secrets:{roomId} -> {address: secret}
     */
    static async storeSecret(roomId: string, address: string, role: number, salt: string, commitment: string, chainId?: number | string): Promise<StoreSecretResult> {
        this.ensureSecureStorageForCriticalPath('storeSecret');

        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const secret: PlayerSecret = { role, salt, commitment };
        const key = `room:secrets:${cid}:${normalizedRoomId}`;
        const normalizedAddress = address.toLowerCase();

        if (!redis) {
            logger.warn({ roomId }, `[ServerStore] Redis not configured. Using MEMORY fallback`);
            if (!memoryStore[key]) memoryStore[key] = {};
            const existing = memoryStore[key][normalizedAddress];
            if (existing) {
                const parsedExisting = JSON.parse(existing) as PlayerSecret;
                if (parsedExisting.role !== role || parsedExisting.salt !== salt) {
                    logger.error({ roomId, address, existingRole: parsedExisting.role, newRole: role }, `[ServerStore] Secret conflict (memory)`);
                    return { status: 'conflict', existingRole: parsedExisting.role };
                }
                return { status: 'exists_same' };
            }

            memoryStore[key][normalizedAddress] = JSON.stringify(secret);
            return { status: 'stored' };
        }

        try {
            const existing = await redis.hget(key, normalizedAddress);
            if (existing) {
                const parsedExisting = JSON.parse(existing) as PlayerSecret;
                if (parsedExisting.role !== role || parsedExisting.salt !== salt) {
                    logger.error({ roomId, address, existingRole: parsedExisting.role, newRole: role }, `[ServerStore] Secret conflict (redis)`);
                    return { status: 'conflict', existingRole: parsedExisting.role };
                }
                await redis.expire(key, GAME_DATA_TTL);
                return { status: 'exists_same' };
            }

            // hset expects string value for ioredis if passing record
            await redis.hset(key, normalizedAddress, JSON.stringify(secret));
            // Set/Refresh expiration so abandoned games get cleaned up
            await redis.expire(key, GAME_DATA_TTL);

            logger.info({ roomId, address }, `[ServerStore] Redis: Stored secret`);
            return { status: 'stored' };
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (store)");
            throw e;
        }
    }

    /**
     * Retrieves all secrets for a specific room.
     */
    static async getRoomSecrets(roomId: string, chainId?: number | string): Promise<Record<string, PlayerSecret> | null> {
        this.ensureSecureStorageForCriticalPath('getRoomSecrets');

        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:secrets:${cid}:${normalizedRoomId}`;

        if (!redis) {
            const data = memoryStore[key];
            if (!data) return null;

            const parsed: Record<string, PlayerSecret> = {};
            for (const [addr, secretStr] of Object.entries(data)) {
                parsed[addr] = JSON.parse(secretStr);
            }
            return parsed;
        }

        try {
            const data = await redis.hgetall(key);
            if (!data || Object.keys(data).length === 0) return null;

            // Parse JSON strings back to PlayerSecret objects
            const parsed: Record<string, PlayerSecret> = {};
            for (let [addr, secretStr] of Object.entries(data)) {
                parsed[addr] = JSON.parse(secretStr as string);
            }
            return parsed;
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (get)");
            return null;
        }
    }

    /**
     * Manually clears room data (optional cleanup).
     */
    static async clearRoom(roomId: string, chainId?: number | string) {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:secrets:${cid}:${normalizedRoomId}`;
        if (!redis) {
            delete memoryStore[key];
            return;
        }
        try {
            await redis.del(key);
            logger.info({ roomId }, `[ServerStore] Redis: Cleared Room`);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (clear)");
        }
    }

    // ============ DISCUSSION STATE ============

    /**
     * Get the current discussion state for a room and day.
     */
    static async getDiscussionState(roomId: string, dayCount: number, chainId?: number | string): Promise<DiscussionState | null> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:discussion:${cid}:${normalizedRoomId}:${dayCount}`;

        const fallback = () => {
            const data = memoryStore[key];
            if (!data || !data['state']) return null;
            return JSON.parse(data['state']);
        };

        if (!redis) {
            return fallback();
        }

        try {
            const data = await redis.get(key);
            if (!data) return null;
            return JSON.parse(data);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (getDiscussion), falling back to memory");
            return fallback();
        }
    }

    /**
     * Set the discussion state for a room and day.
     */
    static async setDiscussionState(roomId: string, dayCount: number, state: DiscussionState, chainId?: number | string) {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:discussion:${cid}:${normalizedRoomId}:${dayCount}`;

        const fallback = () => {
            if (!memoryStore[key]) memoryStore[key] = {};
            memoryStore[key]['state'] = JSON.stringify(state);
        };

        if (!redis) {
            fallback();
            return;
        }

        try {
            await redis.set(key, JSON.stringify(state), 'EX', GAME_DATA_TTL);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (setDiscussion), falling back to memory");
            fallback();
        }
    }

    /**
     * Advance discussion state. Handles transitions between phases.
     * Flow: initial_delay -> speaking -> speaking -> ... -> finished
     */
    static async advanceSpeaker(roomId: string, dayCount: number, totalAlivePlayers: number, force: boolean = false, chainId?: number | string): Promise<DiscussionState | null> {
        const state = await this.getDiscussionState(roomId, dayCount, chainId);
        if (!state || state.finished) return state;

        // Handle initial_delay -> speaking transition
        if (state.phase === 'initial_delay') {
            const newState: DiscussionState = {
                currentSpeakerIndex: 0,
                speakerStartTime: Date.now(),
                speakerDuration: state.speakerDuration,
                finished: false,
                phase: 'speaking'
            };
            await this.setDiscussionState(roomId, dayCount, newState, chainId);
            return newState;
        }

        // Handle speaking -> next speaker or finished
        if (state.phase === 'speaking') {
            // Safety Check: Don't auto-advance if speaking for less than 1.5 seconds (prevents glitches)
            const elapsed = (Date.now() - state.speakerStartTime) / 1000;
            if (!force && elapsed < 1.5) {
                logger.warn({ roomId, elapsed }, `[ServerStore] Ignored premature advance`);
                return state;
            }

            const nextIndex = state.currentSpeakerIndex + 1;

            if (nextIndex >= totalAlivePlayers) {
                // All speakers done -> finished immediately (no final delay)
                const finishedState: DiscussionState = {
                    ...state,
                    finished: true,
                    phase: 'finished'
                };
                await this.setDiscussionState(roomId, dayCount, finishedState, chainId);
                return finishedState;
            }

            // Next speaker directly (no delay between)
            const newState: DiscussionState = {
                currentSpeakerIndex: nextIndex,
                speakerStartTime: Date.now(),
                speakerDuration: state.speakerDuration,
                finished: false,
                phase: 'speaking'
            };
            await this.setDiscussionState(roomId, dayCount, newState, chainId);
            return newState;
        }

        return state;
    }

    /**
     * Clear discussion state (e.g., when voting starts).
     */
    static async clearDiscussionState(roomId: string, dayCount: number, chainId?: number | string) {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:discussion:${cid}:${normalizedRoomId}:${dayCount}`;

        if (!redis) {
            delete memoryStore[key];
            return;
        }

        try {
            await redis.del(key);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (clearDiscussion)");
        }
    }

    // ============ PLAYER AVATARS ============

    /**
     * Store a player's avatar (base64) for a specific room.
     */
    static async storeAvatar(roomId: string, address: string, base64Avatar: string, chainId?: number | string) {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:avatars:${cid}:${normalizedRoomId}`;

        if (!redis) {
            logger.warn({ roomId }, `[ServerStore] Redis not configured. Using MEMORY fallback for avatars`);
            if (!memoryStore[key]) memoryStore[key] = {};
            memoryStore[key][address.toLowerCase()] = base64Avatar;
            return;
        }

        try {
            await redis.hset(key, address.toLowerCase(), base64Avatar);
            await redis.expire(key, GAME_DATA_TTL);
            logger.info({ roomId, address }, `[ServerStore] Stored avatar`);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (storeAvatar)");
        }
    }

    /**
     * Get all avatars for a room.
     * Returns: { "0xaddress": "data:image/...", ... }
     */
    static async getAvatars(roomId: string, chainId?: number | string): Promise<Record<string, string>> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:avatars:${cid}:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key] || {};
        }

        try {
            const data = await redis.hgetall(key);
            return data || {};
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (getAvatars)");
            return {};
        }
    }

    /**
     * Get a single player's avatar.
     */
    static async getAvatar(roomId: string, address: string, chainId?: number | string): Promise<string | null> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:avatars:${cid}:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key]?.[address.toLowerCase()] || null;
        }
        try {
            const avatar = await redis.hget(key, address.toLowerCase());
            return avatar || null;
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (getAvatar)");
            return null;
        }
    }

    // ============ ECIES PUBLIC KEYS ============

    /**
     * Store a player's ECIES public key (65-byte hex) for a specific room.
     * GM uses these to encrypt each player's role individually.
     */
    static async storeEciesPubKey(roomId: string, address: string, pubKeyHex: string, chainId?: number | string): Promise<void> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:ecies_pubkeys:${cid}:${normalizedRoomId}`;
        const normalizedAddress = address.toLowerCase();

        // Basic validation: uncompressed P-256 point = 65 bytes = 130 hex chars
        if (!/^[0-9a-f]{130}$/i.test(pubKeyHex)) {
            throw new Error(`[ServerStore] Invalid ECIES pubkey format for ${address}`);
        }

        if (!redis) {
            if (!memoryStore[key]) memoryStore[key] = {};
            memoryStore[key][normalizedAddress] = pubKeyHex;
            return;
        }

        try {
            await redis.hset(key, normalizedAddress, pubKeyHex);
            await redis.expire(key, GAME_DATA_TTL);
            logger.info({ roomId, address }, `[ServerStore] Stored ECIES pubkey`);
        } catch (e) {
            logger.error({ err: e }, '[ServerStore] Redis error (storeEciesPubKey)');
            throw e;
        }
    }

    /**
     * Get all ECIES public keys for a room.
     * Returns: { "0xaddress": "04abcd...", ... }
     */
    static async getEciesPubKeys(roomId: string, chainId?: number | string): Promise<Record<string, string>> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:ecies_pubkeys:${cid}:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key] || {};
        }

        try {
            const data = await redis.hgetall(key);
            return data || {};
        } catch (e) {
            logger.error({ err: e }, '[ServerStore] Redis error (getEciesPubKeys)');
            return {};
        }
    }

    /**
     * Get all ECIES public key.
     */
    static async getEciesPubKey(roomId: string, address: string, chainId?: number | string): Promise<string | null> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:ecies_pubkeys:${cid}:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key]?.[address.toLowerCase()] || null;
        }

        try {
            const pubKey = await redis.hget(key, address.toLowerCase());
            return pubKey || null;
        } catch (e) {
            logger.error({ err: e }, '[ServerStore] Redis error (getEciesPubKey)');
            return null;
        }
    }

    // ============ GAME LOGS ============

    /**
     * Get all logs for a room.
     */
    static async getGameLogs(roomId: string, chainId?: number | string): Promise<GameLogEntry[]> {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:logs:${cid}:${normalizedRoomId}`;

        if (!redis) {
            const data = memoryStore[key];
            if (!data || !data['list']) return [];
            return JSON.parse(data['list']);
        }

        try {
            const data = await redis.get(key);
            if (!data) return [];
            return JSON.parse(data);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (getGameLogs)");
            return [];
        }
    }

    /**
     * Add a log entry for a room.
     */
    static async addGameLog(roomId: string, log: GameLogEntry, chainId?: number | string) {
        const normalizedRoomId = BigInt(roomId).toString();
        const cid = chainId || '43113';
        const key = `room:logs:${cid}:${normalizedRoomId}`;

        const logs = await this.getGameLogs(roomId, chainId);

        // Prevent duplicate logs (especially from event re-polls)
        if (logs.some(l => l.id === log.id)) return;

        logs.push(log);

        if (!redis) {
            if (!memoryStore[key]) memoryStore[key] = {};
            memoryStore[key]['list'] = JSON.stringify(logs);
            return;
        }

        try {
            await redis.set(key, JSON.stringify(logs), 'EX', GAME_DATA_TTL);
        } catch (e) {
            logger.error({ err: e }, "[ServerStore] Redis error (addGameLog)");
        }
    }
}

/**
 * Game Log Entry structure.
 * Types match client LogEntry.type to ensure correct styling on the frontend.
 */
export interface GameLogEntry {
    id: string;
    message: string;
    type: 'info' | 'success' | 'danger' | 'warning' | 'phase' | 'night';
    timestamp: number;
    eventType?: string;
    eventData?: any;
}

/**
 * Discussion state for turn-based speaking during DAY phase.
 */
export interface DiscussionState {
    currentSpeakerIndex: number;
    speakerStartTime: number; // Unix timestamp (ms)
    speakerDuration: number;  // Seconds per speaker (default: 60)
    finished: boolean;
    // NEW: Delay phase support
    phase: 'initial_delay' | 'speaking' | 'between_delay' | 'final_delay' | 'finished';
    delayStartTime?: number;  // Unix timestamp (ms) when delay started
    delayDuration?: number;   // Duration of current delay in seconds
}

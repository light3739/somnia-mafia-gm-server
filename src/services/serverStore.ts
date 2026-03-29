import { Redis } from 'ioredis';

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
    redis.on('error', (err: any) => console.error('[ServerStore] Redis Connection Error:', err));
}

/**
 * Memory Fallback (for local development without Redis)
 */
const memoryStore: Record<string, Record<string, string>> = {};

// FIX #25: Warn loudly if memoryStore is used in production
if (!redis && process.env.NODE_ENV === 'production') {
    console.error(
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
            console.error('[ServerStore] Redis error (consumeReplayNonce):', e);
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
            console.warn(`[ServerStore] Redis not configured. Using MEMORY fallback for Room #${roomId}`);
            if (!memoryStore[key]) memoryStore[key] = {};
            const existing = memoryStore[key][normalizedAddress];
            if (existing) {
                const parsedExisting = JSON.parse(existing) as PlayerSecret;
                if (parsedExisting.role !== role || parsedExisting.salt !== salt) {
                    console.error(`[ServerStore] Secret conflict (memory) for Room #${roomId}, Player ${address}: existingRole=${parsedExisting.role}, newRole=${role}`);
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
                    console.error(`[ServerStore] Secret conflict (redis) for Room #${roomId}, Player ${address}: existingRole=${parsedExisting.role}, newRole=${role}`);
                    return { status: 'conflict', existingRole: parsedExisting.role };
                }
                await redis.expire(key, GAME_DATA_TTL);
                return { status: 'exists_same' };
            }

            // hset expects string value for ioredis if passing record
            await redis.hset(key, normalizedAddress, JSON.stringify(secret));
            // Set/Refresh expiration so abandoned games get cleaned up
            await redis.expire(key, GAME_DATA_TTL);

            console.log(`[ServerStore] Redis: Stored secret for Room #${roomId}, Player ${address}`);
            return { status: 'stored' };
        } catch (e) {
            console.error("[ServerStore] Redis error (store):", e);
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
            console.error("[ServerStore] Redis error (get):", e);
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
            console.log(`[ServerStore] Redis: Cleared Room #${roomId}`);
        } catch (e) {
            console.error("[ServerStore] Redis error (clear):", e);
        }
    }

    // ============ DISCUSSION STATE ============

    /**
     * Get the current discussion state for a room and day.
     */
    static async getDiscussionState(roomId: string, dayCount: number): Promise<DiscussionState | null> {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:discussion:${normalizedRoomId}:${dayCount}`;

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
            console.error("[ServerStore] Redis error (getDiscussion), falling back to memory:", e);
            return fallback();
        }
    }

    /**
     * Set the discussion state for a room and day.
     */
    static async setDiscussionState(roomId: string, dayCount: number, state: DiscussionState) {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:discussion:${normalizedRoomId}:${dayCount}`;

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
            console.error("[ServerStore] Redis error (setDiscussion), falling back to memory:", e);
            fallback();
        }
    }

    /**
     * Advance discussion state. Handles transitions between phases.
     * Flow: initial_delay -> speaking -> speaking -> ... -> finished
     */
    static async advanceSpeaker(roomId: string, dayCount: number, totalAlivePlayers: number, force: boolean = false): Promise<DiscussionState | null> {
        const state = await this.getDiscussionState(roomId, dayCount);
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
            await this.setDiscussionState(roomId, dayCount, newState);
            return newState;
        }

        // Handle speaking -> next speaker or finished
        if (state.phase === 'speaking') {
            // Safety Check: Don't auto-advance if speaking for less than 1.5 seconds (prevents glitches)
            const elapsed = (Date.now() - state.speakerStartTime) / 1000;
            if (!force && elapsed < 1.5) {
                console.warn(`[ServerStore] Ignored premature advance (elapsed: ${elapsed.toFixed(2)}s)`);
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
                await this.setDiscussionState(roomId, dayCount, finishedState);
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
            await this.setDiscussionState(roomId, dayCount, newState);
            return newState;
        }

        return state;
    }

    /**
     * Clear discussion state (e.g., when voting starts).
     */
    static async clearDiscussionState(roomId: string, dayCount: number) {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:discussion:${normalizedRoomId}:${dayCount}`;

        if (!redis) {
            delete memoryStore[key];
            return;
        }

        try {
            await redis.del(key);
        } catch (e) {
            console.error("[ServerStore] Redis error (clearDiscussion):", e);
        }
    }

    // ============ PLAYER AVATARS ============

    /**
     * Store a player's avatar (base64) for a specific room.
     */
    static async storeAvatar(roomId: string, address: string, base64Avatar: string) {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:avatars:${normalizedRoomId}`;

        if (!redis) {
            console.warn(`[ServerStore] Redis not configured. Using MEMORY fallback for avatars`);
            if (!memoryStore[key]) memoryStore[key] = {};
            memoryStore[key][address.toLowerCase()] = base64Avatar;
            return;
        }

        try {
            await redis.hset(key, address.toLowerCase(), base64Avatar);
            await redis.expire(key, GAME_DATA_TTL);
            console.log(`[ServerStore] Stored avatar for Room #${roomId}, Player ${address.slice(0, 8)}...`);
        } catch (e) {
            console.error("[ServerStore] Redis error (storeAvatar):", e);
        }
    }

    /**
     * Get all avatars for a room.
     * Returns: { "0xaddress": "data:image/...", ... }
     */
    static async getAvatars(roomId: string): Promise<Record<string, string>> {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:avatars:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key] || {};
        }

        try {
            const data = await redis.hgetall(key);
            return data || {};
        } catch (e) {
            console.error("[ServerStore] Redis error (getAvatars):", e);
            return {};
        }
    }

    /**
     * Get a single player's avatar.
     */
    static async getAvatar(roomId: string, address: string): Promise<string | null> {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:avatars:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key]?.[address.toLowerCase()] || null;
        }
        try {
            const avatar = await redis.hget(key, address.toLowerCase());
            return avatar || null;
        } catch (e) {
            console.error("[ServerStore] Redis error (getAvatar):", e);
            return null;
        }
    }

    // ============ ECIES PUBLIC KEYS ============

    /**
     * Store a player's ECIES public key (65-byte hex) for a specific room.
     * GM uses these to encrypt each player's role individually.
     */
    static async storeEciesPubKey(roomId: string, address: string, pubKeyHex: string): Promise<void> {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:ecies_pubkeys:${normalizedRoomId}`;
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
            console.log(`[ServerStore] Stored ECIES pubkey for Room #${roomId}, Player ${address.slice(0, 8)}...`);
        } catch (e) {
            console.error('[ServerStore] Redis error (storeEciesPubKey):', e);
            throw e;
        }
    }

    /**
     * Get all ECIES public keys for a room.
     * Returns: { "0xaddress": "04abcd...", ... }
     */
    static async getEciesPubKeys(roomId: string): Promise<Record<string, string>> {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:ecies_pubkeys:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key] || {};
        }

        try {
            const data = await redis.hgetall(key);
            return data || {};
        } catch (e) {
            console.error('[ServerStore] Redis error (getEciesPubKeys):', e);
            return {};
        }
    }

    /**
     * Get a single player's ECIES public key.
     */
    static async getEciesPubKey(roomId: string, address: string): Promise<string | null> {
        const normalizedRoomId = BigInt(roomId).toString();
        const key = `room:ecies_pubkeys:${normalizedRoomId}`;

        if (!redis) {
            return memoryStore[key]?.[address.toLowerCase()] || null;
        }

        try {
            const pubKey = await redis.hget(key, address.toLowerCase());
            return pubKey || null;
        } catch (e) {
            console.error('[ServerStore] Redis error (getEciesPubKey):', e);
            return null;
        }
    }
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

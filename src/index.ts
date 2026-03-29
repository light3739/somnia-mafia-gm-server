/**
 * index.ts - GM Server Main Entry
 * (Final CI check after fixing remote .env)
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { verifyMessage, type Address, recoverMessageAddress } from 'viem';
import {
  getRoom,
  getPlayers,
  hasCommittedRole,
  getSessionKey,
  resolveNight,
  assertChainConfigOrThrow,
  getChainConfig,
  DIAMOND_ABI,
  GM_ADDRESS,
  avalancheFuji,
  GamePhase,
  FLAGS,
  Role,
  ACTION_TO_ROLE,
  signJoinPermit,
  isTournamentParticipant,
  getTournament,
} from './chain.js';
import { eciesEncrypt } from './ecies.js';
import {
  getOrCreateNightState,
  clearNightState,
  getNightState,
  getAllNightStates,
  injectNightState,
  calculateMafiaConsensus,
  getDoctorHeal,
  type NightAction,
} from './game-state.js';
import {
  connectRedis,
  getRedis,
  rPersistPubkey,
  rPersistSraKey,
  rPersistRole,
  rPersistProof,
  rPersistNightState,
  rDeleteNightState,
  loadAllState,
} from './redis.js';
import { ServerStore } from './services/serverStore.js';
import { generateEndGameProof, calculatePoseidon } from './zk.js';
import { Mutex } from 'async-mutex';

const zkMutex = new Mutex();

const ALLOWED_ORIGINS = [
  'https://mafiaonchain.live',
  'https://test.mafiaonchain.live',
  'http://localhost:3000',
  ...(process.env.CORS_EXTRA_ORIGIN ? [process.env.CORS_EXTRA_ORIGIN] : []),
];

const app = express();
app.set('trust proxy', 1);

// ─── Rate Limiting ──────────────────────────────────────────────────────────
//
// We use THREE different limiters to avoid blocking legitimate gameplay:
//
//  1. pollLimiter  — for HIGH-FREQUENCY polling routes called every ~1-3s per player
//     (win-check, night-status, room-status). 300 req/min = 5req/sec, plenty for polling.
//
//  2. actionLimiter — moderate limit for normal game actions (night-action, role-commit, etc.)
//     A player can't submit more than ~60 actions per minute legitimately.
//
//  3. heavyLimiter  — strict limit for EXPENSIVE operations (ZK proof gen, end-game).
//     These are slow (2-5s each), so 10/minute is more than enough.
//
const pollLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 300,                   // 5 req/sec per IP — covers polling every 1s for ~5 players on same IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many polling requests, please wait.' },
});

const actionLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 60,                    // 1 req/sec — one action per second is more than enough
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many action requests, slow down.' },
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 10,                    // Max 10 heavy ops/min — ZK proof takes 2-5s each
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many heavy requests, please wait.' },
});
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// ─── ZK Hash Service ────────────────────────────
// Used by frontend to generate Poseidon commitments without ZK libs
app.post('/hash-role', async (req, res) => {
  try {
    const { role, salt } = req.body;
    if (role === undefined || !salt) return res.status(400).json({ error: "Missing role or salt" });

    // CIRCUIT EXPECTS: Mafia=1, Town=0
    // We map roles {2, 3, 4} to 0 for ZK compatibility
    const mappedRole = (Number(role) === 1) ? 1 : 0;
    const cleanSalt = salt.startsWith('0x') ? salt.slice(2) : salt;
    const saltBigInt = BigInt("0x" + cleanSalt);

    const commitment = await calculatePoseidon([BigInt(mappedRole), saltBigInt]);
    res.json({ commitment });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = Number(process.env.PORT) || 3001;

// ─── ECIES Role-Privacy Stores ────────────────────────────
// Per room: player address → ECIES public key hex (65-byte uncompressed P-256)
const eciesPubkeys = new Map<string, Map<string, string>>();
// Per room: player address → SRA decryption key (bigint as string)
const sraSKeys = new Map<string, Map<string, string>>();
// Per room: player address → ECIES-resolved role (cached after all SRA keys collected)
const resolvedRoles = new Map<string, Map<string, string>>();
// Per room: stable player order (address[] in join order) — cached on first use or restored during role computation
const roomPlayerOrder = new Map<string, string[]>();

// ─── Session Key Cache (local, replaces on-chain lookups) ───
// mainWallet.lower() → { sessionAddress, roomId }
const sessionCache = new Map<string, { sessionAddress: string; roomId: number }>();

function getRoomMap<V>(map: Map<string, Map<string, V>>, roomId: string): Map<string, V> {
  let m = map.get(roomId);
  if (!m) { m = new Map(); map.set(roomId, m); }
  return m;
}

// SRA helpers (mirrors frontend shuffleService.ts)
const SRA_PRIME = BigInt('0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381' +
  'FFFFFFFFFFFFFFFF');
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}
function sraDecryptCard(encryptedCard: string, decryptionKeys: string[]): string {
  let val = BigInt(encryptedCard);
  for (const key of decryptionKeys) val = modPow(val, BigInt(key), SRA_PRIME);
  return val.toString();
}
function getCardOffset(roomId: number): number {
  return 100 + ((roomId * 7919 + 104729) % 10000);
}
function roleFromCardValue(cardValue: string, roomId: number): string {
  const offset = getCardOffset(roomId);
  const n = parseInt(cardValue) - offset;
  switch (n) {
    case 1: return 'MAFIA';
    case 2: return 'DOCTOR';
    case 3: return 'DETECTIVE';
    case 4: return 'CIVILIAN';
    default: return 'UNKNOWN';
  }
}
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

interface InvestigationProof {
  targetAddress: Address;
  timestamp: number;
}

const investigationProofs = new Map<string, Map<string, InvestigationProof>>();

function storeInvestigationProof(roomId: bigint, detective: Address, target: Address) {
  const roomKey = roomId.toString();
  let roomProofs = investigationProofs.get(roomKey);
  if (!roomProofs) {
    roomProofs = new Map<string, InvestigationProof>();
    investigationProofs.set(roomKey, roomProofs);
  }
  const proof: InvestigationProof = { targetAddress: target, timestamp: Date.now() };
  roomProofs.set(detective.toLowerCase(), proof);
  rPersistProof(getRedis(), roomKey, detective.toLowerCase(), proof);
}

function getInvestigationProof(roomId: bigint, detective: Address): InvestigationProof | null {
  return investigationProofs.get(roomId.toString())?.get(detective.toLowerCase()) || null;
}

async function verifyAuthorizedSignature(params: {
  roomId: string;
  signature: `0x${string}`;
  playerAddress: string;
  signerAddress?: string;
  buildLegacyMessage: () => string;
  buildModernMessage: (nonce: string, timestamp: number) => string;
  nonce?: string;
  timestamp?: number;
  chainId?: number;
  nonceScope?: string; // NEW: optional scope for replay protection
}): Promise<{ ok: true; signer: string } | { ok: false; error: string; status: number }> {
  const {
    roomId,
    signature,
    playerAddress,
    signerAddress,
    buildLegacyMessage,
    buildModernMessage,
    nonce,
    timestamp,
    chainId,
  } = params;

  const normalizedPlayer = playerAddress.toLowerCase();
  const normalizedSigner = (signerAddress || playerAddress).toLowerCase();

  // 1) Try modern signature format if nonce/timestamp provided
  let valid = false;
  if (nonce && timestamp !== undefined) {
    const tsNum = Number(timestamp);
    if (Number.isFinite(tsNum)) {
      // Reject replayed or future-dated timestamps (±5 min window)
      // The frontend sends timestamp in milliseconds (Date.now())
      const now = Date.now();
      const age = now - tsNum;
      // Accept age between -30 seconds (-30000ms) and +5 minutes (300000ms)
      if (age > 300000 || age < -30000) {
        return { ok: false, error: 'Timestamp expired or too far in future (max ±5 min)', status: 401 };
      }

      // Check replay attack protection using nonce
      const scope = params.nonceScope || 'default';
      const isFirstTime = await ServerStore.consumeReplayNonce(scope, roomId, normalizedSigner, nonce);
      if (!isFirstTime) {
        return { ok: false, error: 'Nonce already used (potential replay)', status: 401 };
      }

      valid = await verifyMessage({
        address: normalizedSigner as Address,
        message: buildModernMessage(nonce, tsNum),
        signature,
      });
    }
  }

  // 2) Fallback to legacy format
  if (!valid) {
    valid = await verifyMessage({
      address: normalizedPlayer as Address,
      message: buildLegacyMessage(),
      signature,
    });
    if (valid) {
      return { ok: true, signer: normalizedPlayer };
    }
  }

  if (!valid) {
    return { ok: false, error: 'Invalid signature', status: 401 };
  }

  // If modern signature was from session key, verify it's valid for main wallet
  if (normalizedSigner !== normalizedPlayer) {
    const expectedRoomId = Number(BigInt(roomId));

    // 1) Check LOCAL session cache first (instant, no RPC dependency)
    let cached = sessionCache.get(normalizedPlayer);
    
    // 1.5) Try Redis if local cache miss
    if (!cached) {
      const redis = getRedis();
      if (redis) {
        try {
          const stored = await redis.get(`gm:session:${normalizedPlayer}`);
          if (stored) {
            cached = JSON.parse(stored);
            if (cached) {
              sessionCache.set(normalizedPlayer, cached);
              console.log(`[AUTH] Restored session for ${normalizedPlayer} from Redis`);
            }
          }
        } catch (e) {
          console.warn(`[AUTH] Redis fetch failed for ${normalizedPlayer}`);
        }
      }
    }

    if (cached && cached.sessionAddress === normalizedSigner && cached.roomId === expectedRoomId) {
      return { ok: true, signer: normalizedSigner };
    }

    // 2) Fallback: check on-chain (with retry for RPC lag)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const session = await getSessionKey(normalizedPlayer as Address, chainId) as any;
        const sessionAddress = String(session.sessionAddress || '').toLowerCase();
        const isActive = Boolean(session.isActive);
        const sessionRoomId = Number(session.roomId || 0);

        if (sessionAddress === normalizedSigner && isActive && sessionRoomId === expectedRoomId) {
          // Populate cache for future calls
          sessionCache.set(normalizedPlayer, { sessionAddress: normalizedSigner, roomId: expectedRoomId });
          return { ok: true, signer: normalizedSigner };
        }

        console.warn(`[AUTH] Session mismatch (attempt ${attempt + 1}), retrying...`, { normalizedPlayer, onChain: sessionAddress, expected: normalizedSigner });
        if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
      } catch (e: any) {
        console.warn(`[AUTH] Session lookup failed (attempt ${attempt + 1}), retrying...`, e.message);
        if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
      }
    }

    return { ok: false, error: `Session key mismatch/stale on-chain. Expected: ${normalizedSigner}`, status: 403 };
  }

  return { ok: true, signer: normalizedSigner };
}

// ─── Register Session Key (local cache, no RPC needed) ────
// Frontend calls this immediately after a successful createAndJoin / joinRoom tx.
// The main wallet signs a message proving it owns the session key.
app.post('/register-session', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { mainWallet, sessionAddress, roomId, signature, signerAddress, nonce, timestamp, chainId } = req.body;
    if (!mainWallet || !sessionAddress || !roomId || !signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const normalizedMain = mainWallet.toLowerCase();
    const normalizedSession = sessionAddress.toLowerCase();
    const roomNum = Number(roomId);

    const tsNum = Number(timestamp);
    const message = `register-session:${roomId}:${normalizedMain}:${normalizedSession}:${nonce}:${tsNum}`;

    // Recover address from signature directly
    let recoveredAddress: string;
    try {
      const recoveredFull = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
      recoveredAddress = recoveredFull.toLowerCase();
    } catch (e: any) {
      console.log('[REG-SESSION FAIL] Recovery failed', e.message);
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    if (recoveredAddress !== normalizedMain) {
      console.log('[REG-SESSION FAIL] Signer mismatch', { recoveredAddress, normalizedMain });
      return res.status(401).json({ error: 'Only main wallet can authorize a session key' });
    }

    // Double check with verifyMessage just to be safe
    const valid = await verifyMessage({
      address: recoveredAddress as Address,
      message,
      signature: signature as `0x${string}`,
    });
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Cache it
    sessionCache.set(normalizedMain, { sessionAddress: normalizedSession, roomId: roomNum });

    // Also persist in Redis for restarts
    const redis = getRedis();
    if (redis) {
      redis.set(`gm:session:${normalizedMain}`, JSON.stringify({ sessionAddress: normalizedSession, roomId: roomNum }), 'EX', 48 * 60 * 60).catch(() => {});
    }

    console.log(`[SESSION] Cached session for ${normalizedMain} → ${normalizedSession} (room ${roomNum})`);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[SESSION] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Health ───────────────────────────────────────────────
app.get('/health', (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    gm: GM_ADDRESS,
    activeRooms: getAllNightStates().size,
    uptime: process.uptime(),
  });
});

// ─── Private Rooms: Password Management ──────────────────────
//
// Flow:
//   1. Host creates room → calls POST /room-password to set password
//   2. Player wants to join → calls POST /request-join with password
//   3. GM Server verifies → returns cryptographic signature
//   4. Player passes signature to joinRoom() on-chain → contract verifies via ecrecover
//
// Passwords stored in Redis with 24h TTL (same as game data).

// Host sets password for a room
app.post('/room-password', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, password, hostAddress, signature, signerAddress, nonce, timestamp, chainId } = req.body;

    if (!roomId || !password || !hostAddress || !signature) {
      return res.status(400).json({ error: 'Missing fields: roomId, password, hostAddress, signature' });
    }

    if (typeof password !== 'string' || password.length < 1 || password.length > 64) {
      return res.status(400).json({ error: 'Password must be 1-64 characters' });
    }

    // Verify signature (host must prove they are the host)
    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      playerAddress: String(hostAddress),
      signature: String(signature) as `0x${string}`,
      signerAddress: signerAddress ? String(signerAddress) : undefined,
      nonce: nonce ? String(nonce) : undefined,
      timestamp: timestamp ? Number(timestamp) : undefined,
      chainId: chainId ? Number(chainId) : undefined,
      buildLegacyMessage: () => `setRoomPassword:${String(roomId)}:${String(hostAddress).toLowerCase()}`,
      buildModernMessage: (n: string, ts: number) =>
        `setRoomPassword:${String(roomId)}:${String(hostAddress).toLowerCase()}:${n}:${ts}`,
    });

    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status || 401).json({ error: signatureCheck.error });
    }

    // Verify caller is room host (with retry for RPC sync)
    let room: any = null;
    for (let i = 0; i < 5; i++) {
      try {
        room = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
        if (room && room.host && room.host !== ZERO_ADDR) break;
      } catch (e: any) {
        console.warn(`[room-password] Room ${roomId} lookup attempt ${i + 1} failed: ${e?.message || 'unknown error'}`);
      }
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // exponential backoff
    }

    if (!room || !room.host || room.host === ZERO_ADDR) {
      console.error(`[room-password] Room ${roomId} not found on chain after retries`);
      return res.status(404).json({ error: 'Room not found on chain yet. Please try again in a few seconds.' });
    }

    if (room.host.toLowerCase() !== hostAddress.toLowerCase()) {
      console.error(`[room-password] Room ${roomId} host mismatch: expected ${room.host}, got ${hostAddress}`);
      return res.status(403).json({ error: 'Only the room host can set a password' });
    }

    // NEW: Tournament membership check for host
    if (room.tournamentId && room.tournamentId > 0n) {
      const tournament = await getTournament(room.tournamentId, chainId) as any;
      if (tournament && tournament.buyIn > 0n) {
        const isPart = await isTournamentParticipant(room.tournamentId, hostAddress, chainId);
        if (!isPart) {
          console.error(`[room-password] Room ${roomId}: Host ${hostAddress} not in tournament ${room.tournamentId}`);
          return res.status(403).json({ error: 'Must join tournament first to host this room' });
        }
      }
    }

    // Store password hash in Redis/memory
    const redis = getRedis();
    const passwordKey = `room:password:${chainId || avalancheFuji.id}:${roomId}`;
    const { keccak256, toBytes } = await import('viem');
    const passHash = keccak256(toBytes(password));

    if (redis) {
      await redis.set(passwordKey, passHash, 'EX', 86400); // 24h TTL
    } else {
      (globalThis as any).__roomPasswords = (globalThis as any).__roomPasswords || {};
      (globalThis as any).__roomPasswords[`${chainId || avalancheFuji.id}:${roomId}`] = passHash;
    }

    console.log(`[room-password] Room ${roomId}: password set by ${hostAddress}`);
    return res.json({ success: true });

  } catch (err: any) {
    console.error('[room-password] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Player requests join permit (sends password, gets GM signature back)
app.post('/request-join', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, password, playerAddress, chainId } = req.body;

    if (!roomId || !password || !playerAddress) {
      return res.status(400).json({ error: 'Missing fields: roomId, password, playerAddress' });
    }

    // Get stored password hash
    const redis = getRedis();
    const passwordKey = `room:password:${chainId || avalancheFuji.id}:${roomId}`;
    let storedHash: string | null = null;

    if (redis) {
      storedHash = await redis.get(passwordKey);
    } else {
      storedHash = (globalThis as any).__roomPasswords?.[`${chainId || avalancheFuji.id}:${roomId}`] || null;
    }

    if (!storedHash) {
      console.warn(`[request-join] Room ${roomId} password hash not found in Redis/memory`);
      return res.status(404).json({ error: 'No password set for this room (room is public or expired)' });
    }

    // Verify password
    const { keccak256, toBytes } = await import('viem');
    const providedHash = keccak256(toBytes(password));

    if (providedHash !== storedHash) {
      return res.status(403).json({ error: 'Wrong password' });
    }

    // NEW: Tournament membership check for joiner
    const room = await getRoom(BigInt(roomId), chainId);
    if (room && room.tournamentId && room.tournamentId > 0n) {
      const tournament = await getTournament(room.tournamentId, chainId) as any;
      if (tournament && tournament.buyIn > 0n) {
        const isPart = await isTournamentParticipant(room.tournamentId, playerAddress as Address, chainId);
        if (!isPart) {
          console.error(`[request-join] Room ${roomId}: Player ${playerAddress} not in tournament ${room.tournamentId}`);
          return res.status(403).json({ error: 'Must join tournament first' });
        }
      }
    }

    // Password correct → sign join permit
    const gmSignature = await signJoinPermit(
      BigInt(roomId),
      playerAddress as `0x${string}`,
      chainId ? Number(chainId) : avalancheFuji.id
    );

    console.log(`[request-join] Room ${roomId}: join permit issued for ${playerAddress}`);
    return res.json({
      success: true,
      gmSignature,
    });

  } catch (err: any) {
    console.error('[request-join] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Investigation Proof (GM-verified) ───────────────────
app.post('/investigation-proof', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, detectiveAddress, targetAddress, signature, signerAddress, nonce, timestamp, chainId } = req.body;

    if (!roomId || !detectiveAddress || !targetAddress || !signature) {
      return res.status(400).json({ error: 'Missing fields: roomId, detectiveAddress, targetAddress, signature' });
    }
    const rid = BigInt(roomId);
    const detective = String(detectiveAddress).toLowerCase() as Address;
    const target = String(targetAddress).toLowerCase() as Address;
    const signer = (String(signerAddress || detectiveAddress)).toLowerCase() as Address;

    let valid = false;
    const legacyMessage = `investigate:${roomId}:${(targetAddress as string).toLowerCase()}`;

    if (nonce && timestamp !== undefined) {
      const tsNum = Number(timestamp);
      if (Number.isFinite(tsNum)) {
        // Reject replayed or future-dated timestamps (±5 min window)
        // Frontend sends ms, so we compare in ms
        const age = Date.now() - tsNum;
        if (age > 300000 || age < -30000) {
          return res.status(401).json({ error: 'Timestamp expired or too far in future (max ±5 min)' });
        }
        valid = await verifyMessage({
          address: signer,
          message: `investigate:${roomId}:${req.body.dayCount || 0}:${(targetAddress as string).toLowerCase()}:${nonce}:${tsNum}`,
          signature: signature as `0x${string}`,
        });
      }
    }

    if (!valid) {
      valid = await verifyMessage({
        address: signer,
        message: legacyMessage,
        signature: signature as `0x${string}`,
      });
    }

    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (signer !== detective) {
      const session = await getSessionKey(detective, chainId) as any;
      const sessionAddress = String(session.sessionAddress || '').toLowerCase();
      const expiresAt = Number(session.expiresAt || 0);
      const sessionRoomId = Number(session.roomId || 0);
      const isActive = Boolean(session.isActive);

      if (!sessionAddress || sessionAddress !== signer) {
        return res.status(403).json({ error: 'Session key is not registered for this detective' });
      }

      if (!isActive || expiresAt <= Math.floor(Date.now() / 1000)) {
        return res.status(403).json({ error: 'Session key inactive or expired' });
      }

      if (sessionRoomId !== Number(rid)) {
        return res.status(403).json({ error: 'Session key room mismatch' });
      }
    }

    const proof = getInvestigationProof(rid, detective);
    if (!proof) {
      return res.status(404).json({ error: 'No detective proof found for this room/night' });
    }

    if (proof.targetAddress.toLowerCase() !== target) {
      return res.status(403).json({ error: 'Investigation target mismatch' });
    }

    // Role discovery for detective proof
    const roomRoles = resolvedRoles.get(String(rid));
    const targetRole = roomRoles?.get(target.toLowerCase()) || null;

    return res.json({
      ok: true,
      source: 'gm-proof',
      targetAddress: proof.targetAddress,
      role: targetRole,
      timestamp: proof.timestamp
    });
  } catch (err: any) {
    console.error('[investigation-proof] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Investigation proof check failed' });
  }
});

// ─── Night Auto-Resolution Helpers ───────────────────────

/** Fallback timeout: resolve night even if not all players acted (AFK protection). */
const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 180_000); // default 3 min

const nightTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Remember chainId per room so the timeout callback can resolve on the right chain. */
const nightChainIds = new Map<string, number | undefined>();

function clearNightTimer(roomIdStr: string): void {
  const t = nightTimers.get(roomIdStr);
  if (t) { clearTimeout(t); nightTimers.delete(roomIdStr); }
}

/**
 * Core resolve logic — called internally (auto or timeout), not via HTTP.
 * Submits killTarget / healTarget to the contract and cleans up state.
 */
async function doResolveNight(rid: bigint, chainId?: number): Promise<void> {
  const state = getNightState(rid);
  if (!state || state.resolved) return;
  if (state.actions.size === 0) {
    console.warn(`[auto-resolve] Room ${rid}: no actions submitted — skipping`);
    return;
  }

  state.resolved = true;
  rPersistNightState(getRedis(), String(rid), state);

  const allActions = [...state.actions.values()];

  // Count total alive mafia for correct consensus threshold (AFK mafia count against majority)
  let totalAliveMafia: number | undefined;
  try {
    const chainIdNum = chainId;
    const players = await getPlayers(rid, chainIdNum) as any[];
    const roomRoles = resolvedRoles.get(String(rid));
    if (roomRoles) {
      totalAliveMafia = players.filter((p: any) =>
        !!(Number(p.flags) & FLAGS.ACTIVE) &&
        roomRoles.get(p.wallet.toLowerCase()) === 'MAFIA'
      ).length;
    }
  } catch (_) { /* non-fatal — falls back to voter count */ }

  const killTarget = calculateMafiaConsensus(allActions, totalAliveMafia);
  const healTarget = getDoctorHeal(allActions);

  console.log(`[auto-resolve] Room ${rid}: kill=${killTarget}, heal=${healTarget}, actions=${allActions.length}`);
  try {
    const { hash } = await resolveNight(rid, killTarget, healTarget, chainId);
    console.log(`[auto-resolve] Room ${rid}: tx ${hash}`);
  } catch (err: any) {
    // Reset so host/GM can retry via /resolve-night
    const s = getNightState(rid);
    if (s) { s.resolved = false; rPersistNightState(getRedis(), String(rid), s); }
    throw err;
  } finally {
    clearNightTimer(String(rid));
    nightChainIds.delete(String(rid));
  }
  clearNightState(rid);
  rDeleteNightState(getRedis(), String(rid));
}

/**
 * Start (or reset) the per-room fallback timer.
 * Called on the first night-action of each night.
 */
function scheduleNightTimeout(rid: bigint, chainId?: number): void {
  const key = String(rid);
  clearNightTimer(key);
  nightChainIds.set(key, chainId);
  const t = setTimeout(async () => {
    nightTimers.delete(key);
    const s = getNightState(rid);
    if (!s || s.resolved) return;
    console.log(`[night-timeout] Room ${rid}: ${NIGHT_TIMEOUT_MS / 1000}s timeout — auto-resolving`);
    doResolveNight(rid, chainId).catch((e: any) =>
      console.error(`[night-timeout] Room ${rid}: auto-resolve failed: ${e.message}`)
    );
  }, NIGHT_TIMEOUT_MS);
  nightTimers.set(key, t);
}

/**
 * Returns true when every alive non-CIVILIAN player has submitted a night action.
 * Requires resolvedRoles to be populated (all SRA keys collected).
 */
function allRolePlayersActed(roomIdStr: string, alivePlayers: any[]): boolean {
  const roles = resolvedRoles.get(roomIdStr);
  if (!roles) return false; // SRA keys not all in yet — can't decide
  const roleActors = alivePlayers.filter((p: any) => {
    const r = roles.get(p.wallet.toLowerCase());
    return r && r !== 'CIVILIAN';
  });
  if (roleActors.length === 0) return false;
  const state = getNightState(BigInt(roomIdStr));
  if (!state) return false;
  return roleActors.every((p: any) => state.actions.has(p.wallet.toLowerCase()));
}

// ─── Submit Night Action ──────────────────────────────────
// Players call this instead of on-chain commitNightAction
app.post('/night-action', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, playerAddress, actionType, targetAddress, signature, signerAddress, nonce, timestamp, chainId, dayCount: bodyDayCount } = req.body;

    // Validate inputs
    if (!roomId || !playerAddress || !actionType || !targetAddress || !signature) {
      return res.status(400).json({ error: 'Missing fields: roomId, playerAddress, actionType, targetAddress, signature' });
    }

    if (!['kill', 'heal', 'check'].includes(actionType)) {
      return res.status(400).json({ error: 'actionType must be: kill, heal, check' });
    }

    // Require modern signature (nonce+timestamp) — legacy format disabled to prevent cross-night replay
    if (!nonce || timestamp === undefined) {
      return res.status(400).json({ error: 'nonce and timestamp are required (legacy format not accepted)' });
    }

    const rid = BigInt(roomId);
    const { diamond } = getChainConfig(chainId);
    console.log(`[GM API] Processing night-action for Room:${rid} on Chain:${chainId || 'default(43113)'} Diamond:${diamond}`);

    // 1. Verify room is in NIGHT phase & uses GM mode
    const room: any = await getRoom(rid, chainId);
    const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
    const actualRoomId = Array.isArray(room) ? room[0] : room.id;

    console.log(`[GM API] Room state: Phase=${phase} (Target=${GamePhase.NIGHT}), ID=${actualRoomId}`);

    if (phase !== GamePhase.NIGHT) {
      return res.status(400).json({ error: `Room is not in NIGHT phase (current: ${phase})` });
    }

    // 2. Verify player is in the room and alive
    const players = await getPlayers(rid, chainId);
    const player = players.find(
      (p: any) => p.wallet.toLowerCase() === (playerAddress as string).toLowerCase()
    );
    if (!player) {
      return res.status(400).json({ error: 'Player not in room' });
    }
    if (!(Number(player.flags) & FLAGS.ACTIVE)) {
      return res.status(400).json({ error: 'Player is dead' });
    }

    // 3. Verify the target is valid
    const target = players.find(
      (p: any) => p.wallet.toLowerCase() === (targetAddress as string).toLowerCase()
    );
    if (!target) {
      return res.status(400).json({ error: 'Target not in room' });
    }
    if (actionType === 'kill' && !(Number(target.flags) & FLAGS.ACTIVE)) {
      return res.status(400).json({ error: 'Cannot kill dead player' });
    }
    if (actionType === 'kill' && (playerAddress as string).toLowerCase() === (targetAddress as string).toLowerCase()) {
      return res.status(400).json({ error: 'Cannot target yourself' });
    }

    // 4. Verify signature FIRST (before role check to prevent role enumeration)
    // Use dayCount from the request body — that's what the client signed.
    // If it mismatches the contract we'll catch it via an authorization check below.
    const contractDayCount = Array.isArray(room) ? Number(room[7]) : Number(room.dayCount);
    const sigDayCount = bodyDayCount !== undefined ? Number(bodyDayCount) : contractDayCount;
    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(playerAddress),
      signerAddress,
      nonce,
      timestamp,
      chainId,
      buildLegacyMessage: () => `night:${roomId}:${actionType}:${(targetAddress as string).toLowerCase()}`,
      buildModernMessage: (n, ts) => `night:${roomId}:${sigDayCount}:${actionType}:${(targetAddress as string).toLowerCase()}:${n}:${ts}`,
    });

    if (!signatureCheck.ok) {
      console.error(`[night-action] Sig FAIL Room:${roomId} player:${playerAddress} sigDayCount:${sigDayCount} contractDayCount:${contractDayCount} action:${actionType} target:${targetAddress} nonce:${nonce} ts:${timestamp} err:${signatureCheck.error}`);
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    // Sanity-check: body dayCount must not be more than 1 behind contract (tolerate minor lag)
    if (Math.abs(contractDayCount - sigDayCount) > 1) {
      console.error(`[night-action] dayCount mismatch Room:${roomId} client:${sigDayCount} contract:${contractDayCount}`);
      return res.status(400).json({ error: `dayCount mismatch: client sent ${sigDayCount}, contract has ${contractDayCount}` });
    }

    console.log(`[night-action] Sig OK Room:${roomId} player:${playerAddress} sigDayCount:${sigDayCount} action:${actionType}`);

    // 5. Verify player has committed a role on-chain (completed shuffle phase)
    const committed = await hasCommittedRole(rid, playerAddress as Address, chainId);
    if (!committed) {
      return res.status(403).json({ error: 'You have not committed a role on-chain' });
    }

    // 5b. Verify action type matches player's ECIES-resolved role
    const ACTION_ROLE_MAP: Record<string, string> = { kill: 'MAFIA', heal: 'DOCTOR', check: 'DETECTIVE' };
    const roomRoles = resolvedRoles.get(String(roomId));
    const playerRole = roomRoles?.get((playerAddress as string).toLowerCase());
    if (playerRole) {
      const requiredRole = ACTION_ROLE_MAP[actionType];
      if (requiredRole && playerRole !== requiredRole) {
        return res.status(403).json({
          error: `Action '${actionType}' requires role ${requiredRole} but your role is ${playerRole}`,
        });
      }
    }

    // 6. Store the action
    const state = getOrCreateNightState(rid);
    if (state.resolved) {
      return res.status(400).json({ error: 'Night already resolved' });
    }

    const action: NightAction = {
      playerAddress: playerAddress as Address,
      actionType,
      targetAddress: targetAddress as Address,
      timestamp: Date.now(),
    };

    state.actions.set((playerAddress as string).toLowerCase(), action);
    rPersistNightState(getRedis(), String(roomId), state);

    if (actionType === 'check') {
      storeInvestigationProof(
        rid,
        (playerAddress as string).toLowerCase() as Address,
        (targetAddress as string).toLowerCase() as Address
      );
    }

    const actionsReceived = state.actions.size;
    console.log(
      `[night] Room ${roomId}: ${player.nickname} (${actionType}) → ${target.nickname} | ${actionsReceived} actions total`
    );

    // Auto-resolve: fire immediately when all alive role-players have acted
    const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
    if (allRolePlayersActed(String(roomId), alivePlayers)) {
      console.log(`[night] Room ${roomId}: all role-players acted — auto-resolving`);
      doResolveNight(rid, chainId).catch((e: any) =>
        console.error(`[night] Room ${roomId}: auto-resolve error: ${e.message}`)
      );
    } else if (actionsReceived === 1) {
      // First action of this night — arm the fallback timeout
      scheduleNightTimeout(rid, chainId);
    }

    return res.json({
      ok: true,
      actionsReceived,
    });
  } catch (err: any) {
    console.error('[night-action] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Skip Night Action ────────────────────────────────────
// Allows a player to explicitly "pass" their turn.
// Useful if they lost their local state (salt) or just want to wait.
app.post('/skip-night-action', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, playerAddress, signature, signerAddress, nonce, timestamp, chainId, dayCount } = req.body;
    if (!roomId || !playerAddress || !signature) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const rid = BigInt(roomId);
    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(playerAddress),
      signerAddress,
      nonce,
      timestamp,
      chainId,
      buildLegacyMessage: () => `skip-night:${roomId}`,
      buildModernMessage: (n, ts) => `skip-night:${roomId}:${dayCount || 0}:${n}:${ts}`,
    });

    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    // Verify phase
    const room: any = await getRoom(rid, chainId);
    const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
    if (phase !== GamePhase.NIGHT) {
      return res.status(400).json({ error: 'Room is not in NIGHT phase' });
    }

    const state = getOrCreateNightState(rid);
    if (state.resolved) return res.status(400).json({ error: 'Night already resolved' });

    // Mark as "None" action (effectively a pass)
    const action: NightAction = {
      playerAddress: playerAddress as Address,
      actionType: 'none' as any,
      targetAddress: '0x0000000000000000000000000000000000000000',
      timestamp: Date.now(),
    };

    state.actions.set((playerAddress as string).toLowerCase(), action);
    rPersistNightState(getRedis(), String(roomId), state);

    console.log(`[night] Room ${roomId}: ${playerAddress} skipped action`);

    // Check for auto-resolve
    const players = await getPlayers(rid, chainId);
    const alivePlayers = players.filter((p: any) => !!(Number(p.flags) & FLAGS.ACTIVE));
    if (allRolePlayersActed(String(roomId), alivePlayers)) {
      doResolveNight(rid, chainId).catch(e => console.error(`[night] auto-resolve error: ${e.message}`));
    }

    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[skip-night-action] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Resolve Night ────────────────────────────────────────
// Called by frontend or auto-triggered when all actions are in
app.post('/resolve-night', heavyLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, signature, callerAddress, playerAddress: reqPlayerAddress, signerAddress, nonce, timestamp, chainId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'Missing roomId' });

    // Only GM or authenticated caller can trigger resolve
    if (!signature || !callerAddress) {
      return res.status(401).json({ error: 'Missing signature or callerAddress' });
    }

    // reqPlayerAddress is the main wallet; callerAddress may be a session key.
    // If frontend sends playerAddress, use it as the main wallet and treat callerAddress as the signer.
    const mainWallet = reqPlayerAddress || callerAddress;
    const effectiveSigner = signerAddress || (reqPlayerAddress ? callerAddress : undefined);

    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(mainWallet),
      signerAddress: effectiveSigner,
      nonce,
      timestamp,
      chainId,
      buildLegacyMessage: () => `resolve-night:${roomId}`,
      buildModernMessage: (n, ts) => `resolve-night:${roomId}:${n}:${ts}`,
    });
    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    const rid = BigInt(roomId);

    // Fetch room to verify host and phase
    const resolveRoom: any = await getRoom(rid, chainId);
    const resolvePhase = Array.isArray(resolveRoom) ? Number(resolveRoom[3]) : Number(resolveRoom.phase);
    const resolveHost = (Array.isArray(resolveRoom) ? String(resolveRoom[1]) : String(resolveRoom.host)).toLowerCase();
    const resolveDeadline = Number(Array.isArray(resolveRoom) ? resolveRoom[10] : resolveRoom.phaseDeadline);
    const nowSec = Math.floor(Date.now() / 1000);

    // Restrict to: room host, GM address, OR any room participant after the phase deadline has passed
    // Use mainWallet for comparisons — signatureCheck.signer may be a session key address.
    const callerMainWallet = mainWallet.toLowerCase();
    const isHost = callerMainWallet === resolveHost || signatureCheck.signer === resolveHost;
    const isGM = callerMainWallet === GM_ADDRESS.toLowerCase() || signatureCheck.signer === GM_ADDRESS.toLowerCase();
    const deadlineExpired = resolveDeadline > 0 && nowSec > resolveDeadline;
    if (!isHost && !isGM) {
      if (!deadlineExpired) {
        return res.status(403).json({ error: 'Only the room host or GM can trigger resolve-night before deadline' });
      }
      // After deadline: verify the caller is a participant in the room (check both main wallet and signer)
      const resolvePlayers = await getPlayers(rid, chainId);
      const isParticipant = resolvePlayers.some(
        (p: any) => p.wallet.toLowerCase() === callerMainWallet || p.wallet.toLowerCase() === signatureCheck.signer
      );
      if (!isParticipant) {
        return res.status(403).json({ error: 'Caller is not a participant in this room' });
      }
    }

    if (resolvePhase !== GamePhase.NIGHT) {
      return res.status(400).json({ error: `Room is not in NIGHT phase (current: ${resolvePhase})` });
    }

    const state = getNightState(rid);

    if (!state || state.actions.size === 0) {
      return res.status(400).json({ error: 'No night actions submitted' });
    }
    if (state.resolved) {
      return res.status(400).json({ error: 'Night already resolved' });
    }

    // Calculate consensus
    const allActions = [...state.actions.values()];
    const killTarget = calculateMafiaConsensus(allActions);
    const healTarget = getDoctorHeal(allActions);

    console.log(
      `[resolve] Room ${roomId}: kill=${killTarget}, heal=${healTarget}, actions=${allActions.length}`
    );

    // Submit to contract
    state.resolved = true;
    rPersistNightState(getRedis(), String(roomId), state);
    const { hash } = await resolveNight(rid, killTarget, healTarget, chainId);

    // Clean up
    clearNightState(rid);
    rDeleteNightState(getRedis(), String(roomId));

    return res.json({
      ok: true,
      txHash: hash,
      killTarget,
      healTarget,
    });
  } catch (err: any) {
    console.error('[resolve-night] Error:', err.message);
    // Reset resolved flag if tx fails
    try {
      const rid = BigInt(req.body.roomId);
      const state = getNightState(rid);
      if (state) {
        state.resolved = false;
        rPersistNightState(getRedis(), String(req.body.roomId), state);
      }
    } catch (_) { }
    // Signal txFailed so frontend can fall back to on-chain forcePhaseTimeout
    const isGasTxError = /gas required|insufficient funds|exceed|allowance|Execution reverted/i.test(err.message || '');
    return res.status(500).json({ error: err.message, gmTxFailed: isGasTxError });
  }
});

// ─── Role Commit Sync ────────────────────────────────────
// Frontend calls this to notify GM that a player has committed their role on-chain.
app.post('/role-commit-sync', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, playerAddress, txHash, signature, signerAddress, nonce, timestamp, chainId } = req.body;
    if (!roomId || !playerAddress || !signature) {
      return res.status(401).json({ error: 'Auth required: provide roomId, playerAddress, signature' });
    }
    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(playerAddress),
      signerAddress,
      nonce,
      timestamp,
      chainId,
      buildLegacyMessage: () => `sync-role-commit:${roomId}:${(txHash as string || '')}`,
      buildModernMessage: (n, ts) => `sync-role-commit:${roomId}:${(txHash as string || '')}:${n}:${ts}`,
    });
    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }
    console.log(`[role-commit-sync] Room ${roomId}: Player ${playerAddress} committed role (tx: ${txHash})`);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[role-commit-sync] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Get Night Status ─────────────────────────────────────
// Frontend polls this to check how many actions are in
app.get('/night-status/:roomId', pollLimiter, (req: express.Request, res: express.Response) => {
  const rid = BigInt(req.params.roomId);
  const state = getNightState(rid);

  if (!state) {
    return res.json({ active: false, actionsReceived: 0 });
  }

  return res.json({
    active: true,
    actionsReceived: state.actions.size,
    resolved: state.resolved,
    startedAt: state.nightStartedAt,
    // Don't leak action types — only the count
  });
});

// ─── Get Room Info (convenience proxy) ────────────────────
app.get('/room/:roomId', pollLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const rid = BigInt(req.params.roomId);
    const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
    const [room, players] = await Promise.all([getRoom(rid, chainId), getPlayers(rid, chainId)]);
    return res.json({
      room: {
        id: Number(room.id),
        host: room.host,
        name: room.name,
        phase: room.phase,
        phaseLabel: ['LOBBY', 'SHUFFLING', 'REVEAL', 'DAY', 'VOTING', 'NIGHT', 'ENDED'][room.phase],
        maxPlayers: room.maxPlayers,
        playersCount: room.playersCount,
        aliveCount: room.aliveCount,
        dayCount: room.dayCount,
      },
      players: players.map((p: any) => ({
        wallet: p.wallet,
        nickname: p.nickname,
        active: !!(Number(p.flags) & FLAGS.ACTIVE),
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Register ECIES Public Key ────────────────────────────
app.post('/register-pubkey', actionLimiter, async (req: express.Request, res: express.Response) => {
  const { roomId, playerAddress, pubkey, signature, signerAddress, nonce, timestamp, chainId } = req.body;

  if (!roomId || !playerAddress || !pubkey || !signature) {
    return res.status(400).json({ error: 'Missing req fields: roomId, playerAddress, pubkey, signature' });
  }

  // Validate: 65-byte uncompressed P-256 point starts with "04", followed by 128 hex chars
  if (!/^04[0-9a-fA-F]{128}$/.test(pubkey)) {
    return res.status(400).json({ error: 'Invalid pubkey: expected 65-byte uncompressed P-256 hex (starting with 04)' });
  }

  const normalizedAddr = String(playerAddress).toLowerCase();

  const signatureCheck = await verifyAuthorizedSignature({
    roomId: String(roomId),
    signature: signature as `0x${string}`,
    playerAddress: normalizedAddr,
    signerAddress,
    nonce,
    timestamp,
    chainId,
    buildLegacyMessage: () => `register-pubkey:${roomId}:${normalizedAddr}:${pubkey}`,
    buildModernMessage: (n, ts) => `register-pubkey:${roomId}:${normalizedAddr}:${pubkey}:${n}:${ts}`,
  });

  if (!signatureCheck.ok) {
    return res.status(signatureCheck.status || 401).json({ error: signatureCheck.error });
  }

  // Phase check: only allowed during REVEAL or ENDED (to allow reconnects)
  try {
    const room: any = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
    const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
    if (phase !== GamePhase.REVEAL && phase !== GamePhase.ENDED && phase !== GamePhase.LOBBY) {
      // Allow LOBBY too just in case they generate early, but usually REVEAL
      return res.status(400).json({ error: `Cannot register pubkey outside REVEAL/LOBBY phase (current: ${phase})` });
    }
  } catch (e: any) {
    console.warn(`[register-pubkey] Phase check failed for room ${roomId}: ${e.message}`);
  }

  getRoomMap(eciesPubkeys, String(roomId)).set(normalizedAddr, pubkey);
  rPersistPubkey(getRedis(), String(roomId), normalizedAddr, pubkey);
  console.log(`[ecies] Room ${roomId}: pubkey registered for ${playerAddress}`);
  return res.json({ ok: true });
});

// ─── Submit SRA Decryption Key to GM ─────────────────────
// Players send their real SRA key to GM off-chain (signed).
// GM collects these to decrypt the deck privately — keys never go on-chain.
app.post('/submit-sra-key', actionLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId, playerAddress, sraKey, signature, signerAddress, nonce, timestamp, chainId } = req.body;
    if (!roomId || !playerAddress || !sraKey || !signature) {
      return res.status(400).json({ error: 'Missing: roomId, playerAddress, sraKey, signature' });
    }
    // Validate sraKey is a positive integer
    try {
      if (BigInt(sraKey) <= 0n) throw new Error();
    } catch {
      return res.status(400).json({ error: 'sraKey must be a positive integer string' });
    }

    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(playerAddress),
      signerAddress,
      nonce,
      timestamp,
      chainId,
      buildLegacyMessage: () => `submit-key:${roomId}:${sraKey}`,
      buildModernMessage: (n, ts) => `submit-key:${roomId}:${sraKey}:${n}:${ts}`,
    });
    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    // Phase check (retry up to 10 times for RPC sync)
    let phaseMatch = false;
    let lastPhase = -1;
    for (let i = 0; i < 10; i++) {
      try {
        const room: any = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
        lastPhase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
        if (lastPhase === GamePhase.REVEAL || lastPhase === GamePhase.ENDED) {
          phaseMatch = true;
          break;
        }
      } catch (e: any) {
        console.warn(`[submit-sra-key] Phase check attempt ${i + 1} failed for room ${roomId}: ${e.message}`);
      }
      if (i < 9) await new Promise(r => setTimeout(r, 1000));
    }

    if (!phaseMatch) {
      return res.status(400).json({ error: `Cannot submit SRA key outside REVEAL phase (current: ${lastPhase})` });
    }

    const roomSraKeys = getRoomMap(sraSKeys, String(roomId));
    const normalizedPlayer = String(playerAddress).toLowerCase();
    roomSraKeys.set(normalizedPlayer, String(sraKey));
    rPersistSraKey(getRedis(), String(roomId), normalizedPlayer, String(sraKey));
    console.log(`[ecies] Room ${roomId}: SRA key received from ${playerAddress}`);

    // If all SRA keys are now in, eagerly compute and cache roles for night-action role verification
    try {
      const rid = BigInt(roomId);
      const chainIdNum = chainId ? Number(chainId) : undefined;
      const players = await getPlayers(rid, chainIdNum) as any[];
      // Only require ACTIVE players' keys to trigger role pre-cache.
      // Inactive/kicked players' keys are applied if available but are not required.
      const activePlayers = (players as any[]).filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
      const missingKeys = activeAddrs.filter((addr: string) => !roomSraKeys.has(addr));
      if (missingKeys.length === 0) {
        const { public: publicClient, diamond } = getChainConfig(chainIdNum);
        const deck = await publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI,
          functionName: 'getDeck',
          args: [rid],
        }) as string[];
        // Use STABLE player order for deck index mapping — positions must be locked across the game
        const roomKey = String(roomId);
        let stableOrder = roomPlayerOrder.get(roomKey);
        if (!stableOrder) {
          stableOrder = players.map((p: any) => p.wallet.toLowerCase());
          roomPlayerOrder.set(roomKey, stableOrder);
          console.log(`[deck] Room ${roomId}: player order locked in (${stableOrder.length} players)`);
        }

        const allCollectedKeys = players
          .map((p: any) => roomSraKeys.get(p.wallet.toLowerCase()))
          .filter(Boolean) as string[];

        const roomRoles = getRoomMap(resolvedRoles, roomKey);
        stableOrder.forEach((addr, i) => {
          if (i < deck.length) {
            const role = roleFromCardValue(sraDecryptCard(deck[i], allCollectedKeys), Number(roomId));
            roomRoles.set(addr, role);
            rPersistRole(getRedis(), roomKey, addr, role);
          }
        });
        console.log(`[ecies] Room ${roomId}: all ${activeAddrs.length} active SRA keys collected — roles cached`);
      }
    } catch (cacheErr: any) {
      // Non-fatal — /night-action role verification will be skipped gracefully
      console.error(`[ecies] Room ${roomId}: role pre-cache error: ${cacheErr.message}`);
    }

    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[submit-sra-key] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Get My Role (ECIES encrypted) ───────────────────────
// Returns the player's role encrypted with their registered ECIES pubkey.
// Only the player with the matching private key can decrypt.
// Returns 202 if not all SRA keys are collected yet (player should retry).
app.get('/my-role/:roomId', pollLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId } = req.params;
    const { playerAddress, signature, signerAddress, nonce, timestamp, chainId } = req.query as Record<string, string>;

    if (!playerAddress || !signature) {
      return res.status(400).json({ error: 'Missing query params: playerAddress, signature' });
    }

    const signatureCheck = await verifyAuthorizedSignature({
      roomId,
      signature: signature as `0x${string}`,
      playerAddress,
      signerAddress,
      nonce,
      timestamp: timestamp ? Number(timestamp) : undefined,
      chainId: chainId ? Number(chainId) : undefined,
      buildLegacyMessage: () => `my-role:${roomId}:${playerAddress.toLowerCase()}`,
      buildModernMessage: (n, ts) => `my-role:${roomId}:${playerAddress.toLowerCase()}:${n}:${ts}`,
    });
    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    const normalizedPlayer = playerAddress.toLowerCase();
    const chainIdNum = chainId ? Number(chainId) : undefined;
    const rid = BigInt(roomId);

    // Check ECIES pubkey registered
    const playerPubkey = eciesPubkeys.get(String(roomId))?.get(normalizedPlayer);
    if (!playerPubkey) {
      return res.status(404).json({ error: 'ECIES pubkey not registered. Call POST /register-pubkey first.' });
    }

    // Fast path: serve from pre-computed cache if available
    const cachedRole = resolvedRoles.get(String(roomId))?.get(normalizedPlayer);
    if (cachedRole) {
      const encrypted = eciesEncrypt(playerPubkey, cachedRole);
      console.log(`[ecies] Room ${roomId}: role served from cache to ${playerAddress} (${cachedRole})`);
      return res.json({ encrypted });
    }

    // Get players from chain to find this player's deck index
    const players = await getPlayers(rid, chainIdNum) as any[];

    // Check stable order
    const roomKey = String(roomId);
    let stableOrder = roomPlayerOrder.get(roomKey);
    if (!stableOrder) {
      stableOrder = players.map((p: any) => p.wallet.toLowerCase());
      roomPlayerOrder.set(roomKey, stableOrder);
    }
    const playerIndex = stableOrder.indexOf(normalizedPlayer);
    if (playerIndex === -1) {
      return res.status(404).json({ error: 'Player not found in room order' });
    }

    // Only require ACTIVE players' SRA keys (kicked players may be missing theirs)
    const keyMap = sraSKeys.get(String(roomId));
    const activePlayers = (players as any[]).filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
    const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
    const missingKeys = activeAddrs.filter((addr: string) => !keyMap?.has(addr));
    if (missingKeys.length > 0) {
      return res.status(202).json({
        pending: true,
        keysReceived: activeAddrs.length - missingKeys.length,
        keysExpected: activeAddrs.length,
        message: `Not all SRA keys submitted yet — retry shortly (missing: ${missingKeys.length})`,
      });
    }

    // Read current deck from chain
    const { public: publicClient, diamond } = getChainConfig(chainIdNum);
    const deck = await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI,
      functionName: 'getDeck',
      args: [rid],
    }) as string[];

    if (!deck || deck.length === 0) {
      return res.status(500).json({ error: 'Deck is empty on chain' });
    }
    if (playerIndex >= deck.length) {
      return res.status(500).json({ error: `Player index ${playerIndex} out of deck range ${deck.length}` });
    }

    // Apply ALL collected keys (active + any inactive players who did submit)
    const allCollectedKeys = (players as any[])
      .map((p: any) => keyMap!.get(p.wallet.toLowerCase()))
      .filter(Boolean) as string[];
    const decryptedCard = sraDecryptCard(deck[playerIndex], allCollectedKeys);
    const role = roleFromCardValue(decryptedCard, Number(roomId));

    // Encrypt role with player's ECIES pubkey
    const encrypted = eciesEncrypt(playerPubkey, role);

    console.log(`[ecies] Room ${roomId}: role served to ${playerAddress} (idx=${playerIndex}, role=${role})`);
    return res.json({ encrypted });
  } catch (err: any) {
    console.error('[my-role] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Get All Room Roles (after game ends) ────────────────
// Returns all cached player→role mappings once the GM has collected all SRA keys.
// If the cache is empty but SRA keys exist, attempts on-demand computation from chain data.
// No authentication required — the game is over and roles are public information.
app.get('/room-roles/:roomId', pollLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId } = req.params;
    const { chainId } = req.query as Record<string, string>;
    const rid = BigInt(roomId);
    const chainIdNum = chainId ? Number(chainId) : undefined;

    // SECURITY FIX: Only allow fetching roles if the game has ended, UNLESS authenticated as MAFIA.
    // Since this is a public endpoint, we must hide active roles.
    const room: any = await getRoom(rid, chainIdNum);
    const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);

    // Check if player is authenticated via query signature (for Mafia fetching teammates)
    const { playerAddress, signature, nonce, timestamp } = req.query as Record<string, string>;
    let isVerifiedMafia = false;

    if (playerAddress && signature && nonce && timestamp) {
      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId),
        signature: signature as `0x${string}`,
        playerAddress,
        nonce,
        timestamp: Number(timestamp),
        chainId: chainIdNum,
        buildLegacyMessage: () => `teammates:${roomId}`, // Not used
        buildModernMessage: (n, ts) => `teammates:${roomId}:${n}:${ts}`,
      });
      if (sigCheck.ok) {
        // If sig is valid, check if this player is actually Mafia
        const cached = resolvedRoles.get(String(roomId));
        if (cached && cached.get(playerAddress.toLowerCase()) === 'MAFIA') {
          isVerifiedMafia = true;
        }
      }
    }

    const phaseDeadline = Number(Array.isArray(room) ? room[10] : (room.phaseDeadline || 0));
    const nowSec = Math.floor(Date.now() / 1000);
    // Allow if game ended OR if deadline was > 30s ago (game likely over, chain lag)
    const likelyEnded = phase === GamePhase.ENDED || (phaseDeadline > 0 && nowSec > phaseDeadline + 30);

    if (!likelyEnded && !isVerifiedMafia) {
      return res.status(403).json({ error: `Roles are only public after the game ends. Current phase: ${phase}` });
    }

    // Fast path: serve from cache
    const cached = resolvedRoles.get(String(roomId));
    if (cached && cached.size > 0) {
      const result: Record<string, string> = {};
      for (const [addr, role] of cached) {
        // If not ended but verified as Mafia, ONLY return Mafia teammates
        if (phase !== GamePhase.ENDED && isVerifiedMafia) {
          if (role === 'MAFIA') {
            result[addr.toLowerCase()] = role;
          } else {
            result[addr.toLowerCase()] = 'UNKNOWN'; // hide other roles
          }
        } else {
          result[addr.toLowerCase()] = role;
        }
      }
      return res.json({ roles: result });
    }

    // Cache miss — try to compute from SRA keys we already have
    const keyMap = sraSKeys.get(String(roomId));
    if (!keyMap || keyMap.size === 0) {
      return res.status(202).json({ pending: true, message: 'No SRA keys received yet.' });
    }

    const players = await getPlayers(rid, chainIdNum) as any[];
    const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
    const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
    const missingKeys = activeAddrs.filter((addr: string) => !keyMap.has(addr));

    if (missingKeys.length > 0) {
      return res.status(202).json({
        pending: true,
        keysReceived: keyMap.size,
        keysExpected: activeAddrs.length,
        message: `Waiting for SRA keys — missing ${missingKeys.length} of ${activeAddrs.length} active players.`,
      });
    }

    // All active keys present — decrypt the deck and cache the result
    const { public: publicClient, diamond } = getChainConfig(chainIdNum);
    const deck = await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI,
      functionName: 'getDeck',
      args: [rid],
    }) as string[];

    const allCollectedKeys = players
      .map((p: any) => keyMap.get(p.wallet.toLowerCase()))
      .filter(Boolean) as string[];

    const roomRoles = getRoomMap(resolvedRoles, String(roomId));
    players.forEach((p: any, i: number) => {
      if (i < deck.length) {
        const role = roleFromCardValue(sraDecryptCard(deck[i], allCollectedKeys), Number(roomId));
        roomRoles.set(p.wallet.toLowerCase(), role);
        rPersistRole(getRedis(), String(roomId), p.wallet.toLowerCase(), role);
      }
    });
    console.log(`[room-roles] Room ${roomId}: computed ${roomRoles.size} roles on-demand`);

    const result: Record<string, string> = {};
    for (const [addr, role] of roomRoles) result[addr.toLowerCase()] = role;
    return res.json({ roles: result });
  } catch (err: any) {
    console.error('[room-roles] Error computing on-demand:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /mafia-members/:roomId
 * Returns a sorted list of Mafia member addresses.
 * Requires authentication to prove the caller is a member of the Mafia.
 */
app.get('/mafia-members/:roomId', pollLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId } = req.params;
    const { playerAddress, signature, nonce, timestamp, chainId } = req.query as Record<string, string>;

    if (!playerAddress || !signature || !nonce || !timestamp) {
      return res.status(400).json({ error: 'Missing authentication parameters' });
    }

    const chainIdNum = chainId ? Number(chainId) : undefined;

    // 1. Verify signature
    const sigCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress,
      nonce,
      timestamp: Number(timestamp),
      chainId: chainIdNum,
      buildLegacyMessage: () => `mafia-members:${roomId}`,
      buildModernMessage: (n, ts) => `mafia-members:${roomId}:${n}:${ts}`,
    });

    if (!sigCheck.ok) {
      return res.status(sigCheck.status).json({ error: sigCheck.error });
    }

    // 2. Resolve roles for the room
    const cachedRoles = resolvedRoles.get(String(roomId));
    if (!cachedRoles || cachedRoles.size === 0) {
      // If roles aren't cached, we can't verify yet
      return res.status(202).json({ pending: true, message: 'Roles not yet resolved. Wait for all SRA keys.' });
    }

    // 3. Verify the caller is Mafia
    const callerRole = cachedRoles.get(playerAddress.toLowerCase());
    if (callerRole !== 'MAFIA') {
      return res.status(403).json({ error: 'Access denied: caller is not a member of the Mafia' });
    }

    // 4. Extract and sort Mafia addresses
    const mafiaAddresses: string[] = [];
    for (const [addr, role] of cachedRoles) {
      if (role === 'MAFIA') {
        mafiaAddresses.push(addr.toLowerCase());
      }
    }
    mafiaAddresses.sort();

    return res.json({ mafia: mafiaAddresses });

  } catch (err: any) {
    console.error('[mafia-members] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Win Check ────────────────────────────────────────────────
// The GM is the source of truth for all unrevealed roles.
// Returns the current mafia vs town count to trigger end-game ZK proof.
app.get('/win-check/:roomId', pollLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const roomId = req.params.roomId;
    const chainIdNum = req.query.chainId ? Number(req.query.chainId) : undefined;
    const rid = BigInt(roomId);

    const [room, players] = await Promise.all([
      getRoom(rid, chainIdNum),
      getPlayers(rid, chainIdNum),
    ]);

    const phase = Array.isArray(room) ? Number(room[3]) : Number((room as any).phase);
    if (phase === 0 || phase === GamePhase.ENDED) {
      return res.json({ winDetected: false, phase, message: 'Game not in active phase or already ended' });
    }

    const cachedRoles = resolvedRoles.get(String(roomId));
    if (!cachedRoles || cachedRoles.size === 0) {
      return res.json({ winDetected: false, message: 'Waiting for roles to be resolved' });
    }

    let mafiaCount = 0;
    let townCount = 0;
    let missingSecrets = 0;

    for (const p of players) {
      const active = !!(Number(p.flags) & FLAGS.ACTIVE);
      if (active) {
        const _role = cachedRoles.get(p.wallet.toLowerCase());
        if (!_role) {
          missingSecrets++;
        } else if (_role === 'MAFIA') {
          mafiaCount++;
        } else {
          townCount++;
        }
      }
    }

    if (missingSecrets > 0) {
      console.log(`[win-check] Room ${roomId}: MISSING SECRETS for ${missingSecrets} active players.`);
    }

    let result = null;
    if (missingSecrets === 0) {
      if (mafiaCount === 0) result = 'TOWN_WIN';
      else if (mafiaCount >= townCount) result = 'MAFIA_WIN';
    } else {
      // Even with missing secrets, mafia wins if they outnumber total possible town
      if (mafiaCount > 0 && mafiaCount >= townCount + missingSecrets) {
        result = 'MAFIA_WIN';
      }
    }

    if (result) {
      return res.json({
        winDetected: true,
        result,
        mafiaCount,
        townCount
      });
    }

    return res.json({ winDetected: false, message: 'Game continues' });
  } catch (e: any) {
    console.error(`[win-check] Error in room ${req.params.roomId}:`, e);
    return res.status(500).json({ error: e.message || 'CheckWin failed' });
  }
});

// ─── Start ────────────────────────────────────────────────
async function start() {
  try {
    await assertChainConfigOrThrow();
    await connectRedis();
    const redisClient = getRedis();
    if (redisClient) {
      await loadAllState(redisClient, {
        eciesPubkeys,
        sraSKeys,
        resolvedRoles,
        investigationProofs: investigationProofs as unknown as Map<string, Map<string, any>>,
        injectNight: injectNightState,
      });
      // Re-arm night timeouts for rooms that were mid-night when the server restarted
      for (const [roomIdStr, nightState] of getAllNightStates()) {
        if (!nightState.resolved) {
          const elapsed = Date.now() - nightState.nightStartedAt;
          const remaining = Math.max(5_000, NIGHT_TIMEOUT_MS - elapsed);
          const rid = BigInt(roomIdStr);
          const savedChainId = nightChainIds.get(roomIdStr);
          const t = setTimeout(async () => {
            nightTimers.delete(roomIdStr);
            const s = getNightState(rid);
            if (!s || s.resolved) return;
            console.log(`[night-timeout] Room ${rid}: post-restart timeout — auto-resolving`);
            doResolveNight(rid, savedChainId).catch((e: any) =>
              console.error(`[night-timeout] Room ${rid}: auto-resolve failed: ${e.message}`)
            );
          }, remaining);
          nightTimers.set(roomIdStr, t);
          console.log(`[startup] Room ${roomIdStr}: night in progress — timeout in ${remaining}ms`);
        }
      }

      // Restore session cache from Redis
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
            } catch {}
          }
          if (restored > 0) console.log(`[redis] Restored ${restored} session cache entries`);
        }
      } catch (e: any) {
        console.warn('[redis] Failed to restore session cache:', e.message);
      }

      // Recompute roles for rooms where SRA keys were restored but roles weren't
      for (const [roomId, keyMap] of sraSKeys) {
        const existingRoles = resolvedRoles.get(roomId);
        if (existingRoles && existingRoles.size > 0) continue; // already in Redis

        console.log(`[startup] Room ${roomId}: ${keyMap.size} SRA keys found, roles missing — scheduling recompute`);
        // Trigger async recompute (non-blocking, best-effort)
        (async () => {
          try {
            const rid = BigInt(roomId);
            const players = await getPlayers(rid) as any[];
            // Identify active players
            const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
            const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
            const missingKeys = activeAddrs.filter((addr: string) => !keyMap.has(addr));
            if (missingKeys.length > 0) return; // not all keys yet — /my-role slow path will handle it

            const { public: publicClient, diamond } = getChainConfig();
            const deck = await publicClient.readContract({
              address: diamond,
              abi: DIAMOND_ABI,
              functionName: 'getDeck',
              args: [rid],
            }) as string[];

            // Restore stable order during recompute
            const order = players.map((p: any) => p.wallet.toLowerCase());
            roomPlayerOrder.set(roomId, order);

            const allKeys = players.map((p: any) => keyMap.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
            const roomRoles = getRoomMap(resolvedRoles, roomId);
            order.forEach((addr, i) => {
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
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎭 Mafia GM Server running on port ${PORT}`);
      console.log(`   GM Address: ${GM_ADDRESS}`);
      console.log(`   Health:     http://0.0.0.0:${PORT}/health\n`);
    });
  } catch (error: any) {
    console.error('[startup] Failed to start GM server:', error?.message || error);
    process.exit(1);
  }
}

// ─── End Game ZK Proof (Move from Frontend) ──────────────
app.post('/end-game-zk/:roomId', heavyLimiter, async (req: express.Request, res: express.Response) => {
  try {
    const { roomId } = req.params;
    const { chainId } = req.body; // allow passing chainId if needed
    const rid = BigInt(roomId);

    console.log(`[ZK] Generating end-game proof for Room #${roomId}`);

    const secrets = await ServerStore.getRoomSecrets(roomId);
    if (!secrets) {
      return res.status(400).json({ error: "No secrets for room" });
    }

    const players = await getPlayers(rid, chainId);
    const zkPlayers = players.map((p: any) => {
      const addr = p.wallet.toLowerCase();
      const secret = secrets[addr];
      const isAlive = (Number(p.flags) & FLAGS.ACTIVE) !== 0;

      if (isAlive && !secret?.salt) {
        console.error(`[ZK] Missing salt for alive player ${addr}`);
        // Don't throw if we can't find it for some reason? 
        // Better to throw so we don't generate invalid proof.
        throw new Error(`Missing salt for alive player ${addr}`);
      }

      return {
        role: secret?.role === 1 ? 1 : 0,
        salt: (isAlive && secret) ? secret.salt : "0".repeat(64),
        commitment: (isAlive && secret) ? secret.commitment : "0",
        isActive: isAlive ? 1 : 0,
      };
    });

    const callData = await zkMutex.runExclusive(async () => {
      return generateEndGameProof(roomId, zkPlayers);
    });
    console.log(`[ZK] Proof generated successfully for Room #${roomId}`);
    res.json({ callData });
  } catch (err: any) {
    console.error(`[ZK] Error generating proof: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to generate ZK proof' });
  }
});

void start();

import express from 'express';
import cors from 'cors';
import { verifyMessage, type Address } from 'viem';
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
  GamePhase,
  FLAGS,
  ACTION_TO_ROLE,
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

const ALLOWED_ORIGINS = [
  'https://mafiaonchain.live',
  'https://test.mafiaonchain.live',
  ...(process.env.CORS_EXTRA_ORIGIN ? [process.env.CORS_EXTRA_ORIGIN] : []),
];

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

// ─── ECIES Role-Privacy Stores ────────────────────────────
// Per room: player address → ECIES public key hex (65-byte uncompressed P-256)
const eciesPubkeys = new Map<string, Map<string, string>>();
// Per room: player address → SRA decryption key (bigint as string)
const sraSKeys = new Map<string, Map<string, string>>();
// Per room: player address → ECIES-resolved role (cached after all SRA keys collected)
const resolvedRoles = new Map<string, Map<string, string>>();

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
    try {
      const session = await getSessionKey(normalizedPlayer as Address, chainId) as any;
      const sessionAddress = String(session.sessionAddress || '').toLowerCase();
      const expiresAt = Number(session.expiresAt || 0);
      const sessionRoomId = Number(session.roomId || 0);
      const isActive = Boolean(session.isActive);
      const expectedRoomId = Number(BigInt(roomId));

      if (!sessionAddress || sessionAddress !== normalizedSigner) {
        console.error('[AUTH FAIL] Session key not registered', { normalizedSigner, normalizedPlayer, sessionAddress });
        return { ok: false, error: 'Session key is not registered for this player', status: 403 };
      }

      if (!isActive || expiresAt <= Math.floor(Date.now() / 1000)) {
        console.error('[AUTH FAIL] Session key inactive or expired', { isActive, expiresAt, now: Math.floor(Date.now() / 1000) });
        return { ok: false, error: 'Session key inactive or expired', status: 403 };
      }

      if (sessionRoomId !== expectedRoomId) {
        console.error('[AUTH FAIL] Session key room mismatch', { sessionRoomId, expectedRoomId });
        return { ok: false, error: 'Session key room mismatch', status: 403 };
      }
    } catch (e: any) {
      console.error('[AUTH FAIL] Error fetching session info', e);
      return { ok: false, error: `Session verification failed: ${e?.message || 'unknown error'}`, status: 500 };
    }
  }

  return { ok: true, signer: normalizedSigner };
}

// ─── Health ───────────────────────────────────────────────
app.get('/health', (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    gm: GM_ADDRESS,
    activeRooms: getAllNightStates().size,
    uptime: process.uptime(),
  });
});

// ─── Investigation Proof (GM-verified) ───────────────────
app.post('/investigation-proof', async (req: express.Request, res: express.Response) => {
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
          message: `investigate:${roomId}:${(targetAddress as string).toLowerCase()}:${nonce}:${tsNum}`,
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

    return res.json({ ok: true, source: 'gm-proof', targetAddress: proof.targetAddress, timestamp: proof.timestamp });
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
app.post('/night-action', async (req: express.Request, res: express.Response) => {
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
      buildModernMessage: (n, ts) => `night:${roomId}:${actionType}:${(targetAddress as string).toLowerCase()}:${n}:${ts}`,
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

// ─── Resolve Night ────────────────────────────────────────
// Called by frontend or auto-triggered when all actions are in
app.post('/resolve-night', async (req: express.Request, res: express.Response) => {
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
    } catch (_) {}
    // Signal txFailed so frontend can fall back to on-chain forcePhaseTimeout
    const isGasTxError = /gas required|insufficient funds|exceed|allowance|Execution reverted/i.test(err.message || '');
    return res.status(500).json({ error: err.message, gmTxFailed: isGasTxError });
  }
});

// ─── Role Commit Sync ────────────────────────────────────
// Frontend calls this to notify GM that a player has committed their role on-chain.
app.post('/role-commit-sync', async (req: express.Request, res: express.Response) => {
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
app.get('/night-status/:roomId', (req: express.Request, res: express.Response) => {
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
app.get('/room/:roomId', async (req: express.Request, res: express.Response) => {
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
// Players register their P-256 pubkey so GM can encrypt their role privately.
// No auth required — pubkeys are not secret.
app.post('/register-pubkey', (req: express.Request, res: express.Response) => {
  const { roomId, playerAddress, pubkey } = req.body;
  if (!roomId || !playerAddress || !pubkey) {
    return res.status(400).json({ error: 'Missing: roomId, playerAddress, pubkey' });
  }
  // Validate: 65-byte uncompressed P-256 point starts with "04", followed by 128 hex chars
  if (!/^04[0-9a-fA-F]{128}$/.test(pubkey)) {
    return res.status(400).json({ error: 'Invalid pubkey: expected 65-byte uncompressed P-256 hex (starting with 04)' });
  }
  const normalizedAddr = String(playerAddress).toLowerCase();
  getRoomMap(eciesPubkeys, String(roomId)).set(normalizedAddr, pubkey);
  rPersistPubkey(getRedis(), String(roomId), normalizedAddr, pubkey);
  console.log(`[ecies] Room ${roomId}: pubkey registered for ${playerAddress}`);
  return res.json({ ok: true });
});

// ─── Submit SRA Decryption Key to GM ─────────────────────
// Players send their real SRA key to GM off-chain (signed).
// GM collects these to decrypt the deck privately — keys never go on-chain.
app.post('/submit-sra-key', async (req: express.Request, res: express.Response) => {
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
        // Apply ALL collected keys (including from inactive players who submitted before being kicked)
        const allCollectedKeys = (players as any[])
          .map((p: any) => roomSraKeys.get(p.wallet.toLowerCase()))
          .filter(Boolean) as string[];
        const roomRoles = getRoomMap(resolvedRoles, String(roomId));
        // Use ALL players for deck index mapping — positions are stable across the game
        (players as any[]).forEach((p: any, i: number) => {
          if (i < deck.length) {
            const role = roleFromCardValue(sraDecryptCard(deck[i], allCollectedKeys), Number(roomId));
            roomRoles.set(p.wallet.toLowerCase(), role);
            rPersistRole(getRedis(), String(roomId), p.wallet.toLowerCase(), role);
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
app.get('/my-role/:roomId', async (req: express.Request, res: express.Response) => {
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
    const playerIndex = players.findIndex((p: any) => p.wallet.toLowerCase() === normalizedPlayer);
    if (playerIndex === -1) {
      return res.status(404).json({ error: 'Player not found in room' });
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
app.get('/room-roles/:roomId', async (req: express.Request, res: express.Response) => {
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

    if (phase !== GamePhase.ENDED && !isVerifiedMafia) {
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

void start();

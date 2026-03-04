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
  GM_ADDRESS,
  DIAMOND_ADDRESS,
  GamePhase,
  FLAGS,
  ACTION_TO_ROLE,
} from './chain.js';
import {
  getOrCreateNightState,
  clearNightState,
  getNightState,
  getAllNightStates,
  calculateMafiaConsensus,
  getDoctorHeal,
  type NightAction,
} from './game-state.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;
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
  roomProofs.set(detective.toLowerCase(), { targetAddress: target, timestamp: Date.now() });
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
  } = params;

  const normalizedPlayer = playerAddress.toLowerCase();
  const normalizedSigner = (signerAddress || playerAddress).toLowerCase();

  // 1) Try modern signature format if nonce/timestamp provided
  let valid = false;
  if (nonce && timestamp !== undefined) {
    const tsNum = Number(timestamp);
    if (Number.isFinite(tsNum)) {
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
      const session = await getSessionKey(normalizedPlayer as Address) as any;
      const sessionAddress = String(session.sessionAddress || '').toLowerCase();
      const expiresAt = Number(session.expiresAt || 0);
      const sessionRoomId = Number(session.roomId || 0);
      const isActive = Boolean(session.isActive);

      if (!sessionAddress || sessionAddress !== normalizedSigner) {
        return { ok: false, error: 'Session key is not registered for this player', status: 403 };
      }

      if (!isActive || expiresAt <= Math.floor(Date.now() / 1000)) {
        return { ok: false, error: 'Session key inactive or expired', status: 403 };
      }

      if (sessionRoomId !== Number(BigInt(roomId))) {
        return { ok: false, error: 'Session key room mismatch', status: 403 };
      }
    } catch (e: any) {
      return { ok: false, error: `Session verification failed: ${e?.message || 'unknown error'}`, status: 500 };
    }
  }

  return { ok: true, signer: normalizedSigner };
}

// ─── Health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    gm: GM_ADDRESS,
    diamond: DIAMOND_ADDRESS,
    activeRooms: getAllNightStates().size,
    uptime: process.uptime(),
  });
});

// ─── Investigation Proof (GM-verified) ───────────────────
app.post('/investigation-proof', async (req, res) => {
  try {
    const { roomId, detectiveAddress, targetAddress, signature, signerAddress, nonce, timestamp } = req.body;

    if (!roomId || !detectiveAddress || !targetAddress || !signature) {
      return res.status(400).json({ error: 'Missing fields: roomId, detectiveAddress, targetAddress, signature' });
    }
    const rid = BigInt(roomId);
    const detective = String(detectiveAddress).toLowerCase() as Address;
    const target = String(targetAddress).toLowerCase() as Address;
    const signer = (String(signerAddress || detectiveAddress)).toLowerCase() as Address;

    let valid = false;
    const legacyMessage = `investigate:${roomId}:${targetAddress}`;

    if (nonce && timestamp !== undefined) {
      const tsNum = Number(timestamp);
      if (Number.isFinite(tsNum)) {
        valid = await verifyMessage({
          address: signer,
          message: `investigate:${roomId}:${targetAddress}:${nonce}:${tsNum}`,
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
      const session = await getSessionKey(detective) as any;
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

// ─── Submit Night Action ──────────────────────────────────
// Players call this instead of on-chain commitNightAction
app.post('/night-action', async (req, res) => {
  try {
    const { roomId, playerAddress, actionType, targetAddress, signature, signerAddress, nonce, timestamp } = req.body;

    // Validate inputs
    if (!roomId || !playerAddress || !actionType || !targetAddress || !signature) {
      return res.status(400).json({ error: 'Missing fields: roomId, playerAddress, actionType, targetAddress, signature' });
    }

    if (!['kill', 'heal', 'check'].includes(actionType)) {
      return res.status(400).json({ error: 'actionType must be: kill, heal, check' });
    }

    const rid = BigInt(roomId);

    // 1. Verify room is in NIGHT phase & uses GM mode
    const room = await getRoom(rid);
    if (room.phase !== GamePhase.NIGHT) {
      return res.status(400).json({ error: 'Room is not in NIGHT phase' });
    }

    // 2. Verify player is in the room and alive
    const players = await getPlayers(rid);
    const player = players.find(
      (p) => p.wallet.toLowerCase() === (playerAddress as string).toLowerCase()
    );
    if (!player) {
      return res.status(400).json({ error: 'Player not in room' });
    }
    if (!(Number(player.flags) & FLAGS.ACTIVE)) {
      return res.status(400).json({ error: 'Player is dead' });
    }

    // 3. Verify the target is valid
    const target = players.find(
      (p) => p.wallet.toLowerCase() === (targetAddress as string).toLowerCase()
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
    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(playerAddress),
      signerAddress,
      nonce,
      timestamp,
      buildLegacyMessage: () => `night:${roomId}:${actionType}:${targetAddress}`,
      buildModernMessage: (n, ts) => `night:${roomId}:${actionType}:${targetAddress}:${n}:${ts}`,
    });

    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    // 5. Verify player has committed a role on-chain (completed shuffle phase)
    const committed = await hasCommittedRole(rid, playerAddress as Address);
    if (!committed) {
      return res.status(403).json({ error: 'You have not committed a role on-chain' });
    }

    // Note: We trust the actionType from the signed message.
    // If a player lies (e.g. citizen claims kill), it has no real effect —
    // they get punished at revealRole() time via FLAG_CLAIMED_MAFIA checks.

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

    if (actionType === 'check') {
      storeInvestigationProof(
        rid,
        (playerAddress as string).toLowerCase() as Address,
        (targetAddress as string).toLowerCase() as Address
      );
    }

    console.log(
      `[night] Room ${roomId}: ${player.nickname} (${actionType}) → ${target.nickname} | ${state.actions.size} actions total`
    );

    return res.json({
      ok: true,
      actionsReceived: state.actions.size,
    });
  } catch (err: any) {
    console.error('[night-action] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Resolve Night ────────────────────────────────────────
// Called by frontend or auto-triggered when all actions are in
app.post('/resolve-night', async (req, res) => {
  try {
    const { roomId, signature, callerAddress, signerAddress, nonce, timestamp } = req.body;
    if (!roomId) return res.status(400).json({ error: 'Missing roomId' });

    // Only GM or authenticated caller can trigger resolve
    if (!signature || !callerAddress) {
      return res.status(401).json({ error: 'Missing signature or callerAddress' });
    }

    const signatureCheck = await verifyAuthorizedSignature({
      roomId: String(roomId),
      signature: signature as `0x${string}`,
      playerAddress: String(callerAddress),
      signerAddress,
      nonce,
      timestamp,
      buildLegacyMessage: () => `resolve-night:${roomId}`,
      buildModernMessage: (n, ts) => `resolve-night:${roomId}:${n}:${ts}`,
    });
    if (!signatureCheck.ok) {
      return res.status(signatureCheck.status).json({ error: signatureCheck.error });
    }

    const rid = BigInt(roomId);
    const state = getNightState(rid);

    if (!state || state.actions.size === 0) {
      return res.status(400).json({ error: 'No night actions submitted' });
    }
    if (state.resolved) {
      return res.status(400).json({ error: 'Night already resolved' });
    }

    // Verify room is still in NIGHT phase
    const room = await getRoom(rid);
    if (room.phase !== GamePhase.NIGHT) {
      return res.status(400).json({ error: 'Room is not in NIGHT phase' });
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
    const { hash } = await resolveNight(rid, killTarget, healTarget);

    // Clean up
    clearNightState(rid);

    return res.json({
      ok: true,
      txHash: hash,
      killTarget,
      healTarget,
    });
  } catch (err: any) {
    console.error('[resolve-night] Error:', err.message);
    // Reset resolved flag if tx fails
    const rid = BigInt(req.body.roomId);
    const state = getNightState(rid);
    if (state) state.resolved = false;
    return res.status(500).json({ error: err.message });
  }
});

// ─── Get Night Status ─────────────────────────────────────
// Frontend polls this to check how many actions are in
app.get('/night-status/:roomId', (req, res) => {
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
app.get('/room/:roomId', async (req, res) => {
  try {
    const rid = BigInt(req.params.roomId);
    const [room, players] = await Promise.all([getRoom(rid), getPlayers(rid)]);
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
      players: players.map((p) => ({
        wallet: p.wallet,
        nickname: p.nickname,
        active: !!(Number(p.flags) & FLAGS.ACTIVE),
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────
async function start() {
  try {
    await assertChainConfigOrThrow();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎭 Mafia GM Server running on port ${PORT}`);
      console.log(`   GM Address: ${GM_ADDRESS}`);
      console.log(`   Diamond:    ${DIAMOND_ADDRESS}`);
      console.log(`   Health:     http://0.0.0.0:${PORT}/health\n`);
    });
  } catch (error: any) {
    console.error('[startup] Failed to start GM server:', error?.message || error);
    process.exit(1);
  }
}

void start();

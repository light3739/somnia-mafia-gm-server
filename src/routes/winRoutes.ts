/**
 * routes/winRoutes.ts
 * GET  /win-check/:roomId    — mafia vs town count for end-game detection
 * POST /end-game-zk/:roomId  — generate ZK proof and return calldata
 * POST /hash-role             — compute Poseidon commitment (used by frontend)
 */
import { Router } from 'express';
import { getRoom, getPlayers, FLAGS, GamePhase } from '../chain.js';
import { resolvedRoles } from '../stores/index.js';
import { ServerStore } from '../services/serverStore.js';
import { generateEndGameProof, calculatePoseidon } from '../zk.js';
import { Mutex } from 'async-mutex';
import type { RateLimitRequestHandler } from 'express-rate-limit';

const zkMutex = new Mutex();

export function createWinRoutes(
  pollLimiter: RateLimitRequestHandler,
  heavyLimiter: RateLimitRequestHandler,
) {
  const router = Router();

  // ── Poseidon hash helper ──────────────────────────────────
  router.post('/hash-role', async (req, res) => {
    try {
      const { role, salt } = req.body;
      if (role === undefined || !salt) return res.status(400).json({ error: 'Missing role or salt' });
      const mappedRole = Number(role) === 1 ? 1 : 0;
      const cleanSalt = salt.startsWith('0x') ? salt.slice(2) : salt;
      const saltBigInt = BigInt('0x' + cleanSalt);
      const commitment = await calculatePoseidon([BigInt(mappedRole), saltBigInt]);
      res.json({ commitment });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Win Check ─────────────────────────────────────────────
  router.get('/win-check/:roomId', pollLimiter, async (req, res) => {
    try {
      const roomId = req.params.roomId;
      const chainIdNum = req.query.chainId ? Number(req.query.chainId) : undefined;
      const rid = BigInt(roomId);

      const [room, players] = await Promise.all([getRoom(rid, chainIdNum), getPlayers(rid, chainIdNum)]);
      const phase = Array.isArray(room) ? Number(room[3]) : Number((room as any).phase);

      if (phase === 0 || phase === GamePhase.ENDED) {
        return res.json({ winDetected: false, phase, message: 'Game not active or already ended' });
      }

      const cachedRoles = resolvedRoles.get(String(roomId));
      if (!cachedRoles || cachedRoles.size === 0) {
        return res.json({ winDetected: false, message: 'Waiting for roles to be resolved' });
      }

      let mafiaCount = 0, townCount = 0, missingSecrets = 0;
      for (const p of players) {
        if (Number(p.flags) & FLAGS.ACTIVE) {
          const _role = cachedRoles.get(p.wallet.toLowerCase());
          if (!_role) missingSecrets++;
          else if (_role === 'MAFIA') mafiaCount++;
          else townCount++;
        }
      }

      let result: string | null = null;
      if (missingSecrets === 0) {
        if (mafiaCount === 0) result = 'TOWN_WIN';
        else if (mafiaCount >= townCount) result = 'MAFIA_WIN';
      } else {
        if (mafiaCount > 0 && mafiaCount >= townCount + missingSecrets) result = 'MAFIA_WIN';
      }

      if (result) return res.json({ winDetected: true, result, mafiaCount, townCount });
      return res.json({ winDetected: false, message: 'Game continues' });
    } catch (e: any) {
      console.error(`[win-check] Error in room ${req.params.roomId}:`, e);
      return res.status(500).json({ error: e.message || 'CheckWin failed' });
    }
  });

  // ── End-Game ZK Proof ─────────────────────────────────────
  router.post('/end-game-zk/:roomId', heavyLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { chainId } = req.body;
      const rid = BigInt(roomId);

      console.log(`[ZK] Generating end-game proof for Room #${roomId}`);
      const secrets = await ServerStore.getRoomSecrets(roomId);
      if (!secrets) return res.status(400).json({ error: 'No secrets for room' });

      const players = await getPlayers(rid, chainId);
      const zkPlayers = players.map((p: any) => {
        const addr = p.wallet.toLowerCase();
        const secret = secrets[addr];
        const isAlive = (Number(p.flags) & FLAGS.ACTIVE) !== 0;
        if (isAlive && !secret?.salt) throw new Error(`Missing salt for alive player ${addr}`);
        return {
          role: secret?.role === 1 ? 1 : 0,
          salt: isAlive && secret ? secret.salt : '0'.repeat(64),
          commitment: isAlive && secret ? secret.commitment : '0',
          isActive: isAlive ? 1 : 0,
        };
      });

      const callData = await zkMutex.runExclusive(() => generateEndGameProof(roomId, zkPlayers));
      console.log(`[ZK] Proof generated for Room #${roomId}`);
      res.json({ callData });
    } catch (err: any) {
      console.error(`[ZK] Error generating proof: ${err.message}`);
      res.status(500).json({ error: err.message || 'Failed to generate ZK proof' });
    }
  });

  return router;
}

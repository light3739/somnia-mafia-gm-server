/**
 * routes/winRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, FLAGS } from '../chain.js';
import { Role } from '../types/contract.js';
import type { GMStore } from '../stores/index.js';
import { ServerStore } from '../services/serverStore.js';
import { generateEndGameProof, calculatePoseidon } from '../zk.js';
import { Mutex } from 'async-mutex';
import type { RateLimitRequestHandler } from 'express-rate-limit';

const zkMutex = new Mutex();

export interface WinRoutesContext {
  store: GMStore;
  verifyAuthorizedSignature: any;
  pollLimiter: RateLimitRequestHandler;
  heavyLimiter: RateLimitRequestHandler;
}

export function createWinRoutes(ctx: WinRoutesContext) {
  const router = Router();
  const { store, verifyAuthorizedSignature, pollLimiter, heavyLimiter } = ctx;

  router.post('/hash-role', async (req, res) => {
    try {
      const { role, salt } = req.body;
      const mappedRole = Number(role) === 1 ? 1 : 0;
      const commitment = await calculatePoseidon([BigInt(mappedRole), BigInt("0x" + (salt.startsWith('0x') ? salt.slice(2) : salt))]);
      return res.json({ commitment });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.post('/submit-role-secret', heavyLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, role, salt, commitment, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      if (!roomId || !playerAddress || !salt || !commitment || !signature) {
        return res.status(400).json({ error: 'Missing fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `submit-role-secret:${roomId}:${role}:${salt}:${commitment}`,
        buildModernMessage: (n: string, ts: number) => `submit-role-secret:${chainId || 43113}:${roomId}:${role}:${salt}:${commitment}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Optional: Verify commitment against role+salt
      const mappedRole = Number(role) === 1 ? 1 : 0;
      const computed = await calculatePoseidon([BigInt(mappedRole), BigInt("0x" + salt.replace("0x",""))]);
      if (computed !== commitment) return res.status(400).json({ error: 'Commitment mismatch' });

      await ServerStore.storeSecret(String(roomId), String(playerAddress), Number(role), String(salt), String(commitment), chainId);
      
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/win-check/:roomId', pollLimiter, async (req, res) => {
    try {
      const rid = BigInt(req.params.roomId);
      const cid = req.query.chainId ? Number(req.query.chainId) : undefined;
      const [room, players] = await Promise.all([getRoom(rid, cid), getPlayers(rid, cid)]);
      const roles = store.resolvedRoles.get(String(req.params.roomId));
      if (!roles) return res.json({ winDetected: false });

      let mafiaCount = 0, townCount = 0;
      for (const p of players) {
        if (Number(p.flags) & FLAGS.ACTIVE) {
          const r = roles.get(p.wallet.toLowerCase());
          if (r === Role.MAFIA) mafiaCount++;
          else if (r !== undefined && r !== Role.NONE) townCount++;
        }
      }
      if (mafiaCount === 0) return res.json({ winDetected: true, result: 'TOWN_WIN' });
      if (mafiaCount >= townCount) return res.json({ winDetected: true, result: 'MAFIA_WIN' });
      return res.json({ winDetected: false });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.post('/end-game-zk/:roomId', heavyLimiter, async (req, res) => {
    try {
      const rid = req.params.roomId;
      const cid = req.body.chainId;
      const secrets = await ServerStore.getRoomSecrets(rid, cid);
      if (!secrets) return res.status(400).json({ error: 'No secrets found for this room. Players must submit secrets first.' });
      
      const players = await getPlayers(BigInt(rid), cid);
      const zkInput = players.map((p: any) => {
        const addr = p.wallet.toLowerCase();
        const s = secrets[addr];
        const alive = !!(Number(p.flags) & FLAGS.ACTIVE);
        return {
          role: s?.role === 1 ? 1 : 0,
          salt: (alive && s) ? s.salt : "0".repeat(64),
          commitment: (alive && s) ? s.commitment : "0",
          isActive: alive ? 1 : 0,
        };
      });
      const callData = await zkMutex.runExclusive(() => generateEndGameProof(rid, zkInput));
      return res.json({ callData });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

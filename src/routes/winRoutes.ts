/**
 * routes/winRoutes.ts
 */
import { Router } from 'express';
import { getRoom, getPlayers, FLAGS, GamePhase } from '../chain.js';
import type { GMStore } from '../stores/index.js';
import { ServerStore } from '../services/serverStore.js';
import { generateEndGameProof, calculatePoseidon } from '../zk.js';
import { Mutex } from 'async-mutex';
import type { RateLimitRequestHandler } from 'express-rate-limit';

const zkMutex = new Mutex();

export interface WinRoutesContext {
  store: GMStore;
  pollLimiter: RateLimitRequestHandler;
  heavyLimiter: RateLimitRequestHandler;
}

export function createWinRoutes(ctx: WinRoutesContext) {
  const router = Router();
  const { store, pollLimiter, heavyLimiter } = ctx;

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

  router.get('/win-check/:roomId', pollLimiter, async (req, res) => {
    try {
      const rid = BigInt(req.params.roomId);
      const [room, players] = await Promise.all([getRoom(rid, req.query.chainId as any), getPlayers(rid, req.query.chainId as any)]);
      const roles = store.resolvedRoles.get(String(req.params.roomId));
      if (!roles) return res.json({ winDetected: false });

      let mafiaCount = 0, townCount = 0;
      for (const p of players) {
        if (Number(p.flags) & FLAGS.ACTIVE) {
          const r = roles.get(p.wallet.toLowerCase());
          if (r === 'MAFIA') mafiaCount++;
          else if (r) townCount++;
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
      const secrets = await ServerStore.getRoomSecrets(req.params.roomId);
      if (!secrets) return res.status(400).json({ error: 'No secrets' });
      const players = await getPlayers(BigInt(req.params.roomId), req.body.chainId);
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
      const callData = await zkMutex.runExclusive(() => generateEndGameProof(req.params.roomId, zkInput));
      return res.json({ callData });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

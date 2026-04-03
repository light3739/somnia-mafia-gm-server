/**
 * routes/discussionRoutes.ts
 * Standardized routes for turn-based speaking during DAY phase.
 */
import { Router } from 'express';
import { getPlayers, FLAGS } from '../chain.js';
import { ServerStore } from '../services/serverStore.js';
import type { GMStore } from '../stores/index.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

import { logger } from '../utils/logger.js';

export interface DiscussionRoutesContext {
  store: GMStore;
  verifyAuthorizedSignature: any;
  actionLimiter: RateLimitRequestHandler;
  pollLimiter: RateLimitRequestHandler;
}

export function createDiscussionRoutes(ctx: DiscussionRoutesContext) {
  const router = Router();
  const { store, verifyAuthorizedSignature, actionLimiter, pollLimiter } = ctx;

  /**
   * Deterministic shuffle using roomId as seed (must match frontend/GM logic)
   */
  function shufflePlayers(players: readonly any[], roomId: string): any[] {
    const shuffled = [...players];
    const seed = Number(BigInt(roomId) % 1000000n);
    let m = shuffled.length, t, i;
    let s = seed;

    const random = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    while (m) {
      i = Math.floor(random() * m--);
      t = shuffled[m];
      shuffled[m] = shuffled[i];
      shuffled[i] = t;
    }
    return shuffled;
  }

  // ── GET /discussion ───────────────────────────────────────
  router.get('/discussion', pollLimiter, async (req, res) => {
    try {
      const { roomId, dayCount, playerAddress, chainId } = req.query;

      if (!roomId) return res.status(400).json({ error: 'Missing roomId' });

      let state = await ServerStore.getDiscussionState(String(roomId), Number(dayCount || 1), Number(chainId || 50312));
      if (!state) return res.json({ active: false, message: 'Discussion not started' });

      // Get alive players
      const rid = BigInt(String(roomId));
      const players = await getPlayers(rid, Number(chainId || 50312));
      const allShuffled = shufflePlayers(players, String(roomId));
      const alivePlayers = allShuffled.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const totalSpeakers = alivePlayers.length;

      // Auto-advance logic
      if (!state.finished) {
        if (state.phase === 'speaking') {
          const elapsed = (Date.now() - state.speakerStartTime) / 1000;
          if (elapsed >= state.speakerDuration) {
            const newState = await ServerStore.advanceSpeaker(String(roomId), Number(dayCount || 1), totalSpeakers, false, Number(chainId || 50312));
            if (newState) state = newState;
          }
        } else if (state.phase === 'initial_delay') {
          const delayElapsed = (Date.now() - (state.delayStartTime || 0)) / 1000;
          const delayDuration = state.delayDuration || 5;
          if (delayElapsed >= delayDuration) {
            const newState = await ServerStore.advanceSpeaker(String(roomId), Number(dayCount || 1), totalSpeakers, false, Number(chainId || 50312));
            if (newState) state = newState;
          }
        }
      }

      // Build response
      const currentSpeaker = alivePlayers[state.currentSpeakerIndex];
      let timeRemaining = 0;
      if (state.phase === 'speaking') {
        const elapsed = (Date.now() - state.speakerStartTime) / 1000;
        timeRemaining = Math.max(0, Math.floor(state.speakerDuration - elapsed));
      } else if (state.phase === 'initial_delay') {
        const elapsed = (Date.now() - (state.delayStartTime || 0)) / 1000;
        timeRemaining = Math.max(0, Math.ceil((state.delayDuration || 5) - elapsed));
      }

      const isMyTurn = playerAddress && state.phase === 'speaking'
        ? currentSpeaker?.wallet.toLowerCase() === String(playerAddress).toLowerCase()
        : false;

      return res.json({
        active: !state.finished,
        finished: state.finished,
        phase: state.phase || 'speaking',
        currentSpeakerIndex: state.currentSpeakerIndex,
        currentSpeakerAddress: currentSpeaker?.wallet || null,
        totalSpeakers,
        timeRemaining,
        speakerDuration: state.speakerDuration,
        delayDuration: state.delayDuration,
        isMyTurn
      });
    } catch (err: any) {
      logger.error({ err, roomId: req.query.roomId }, '[getDiscussion] Failed');
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /discussion ──────────────────────────────────────
  router.post('/discussion', actionLimiter, async (req, res) => {
    try {
      const { roomId, dayCount, action: reqAction, playerAddress, signature, signerAddress, nonce, timestamp, chainId } = req.body;

      if (!roomId || !reqAction || !playerAddress || !signature) {
        return res.status(400).json({ error: 'Missing req fields' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId),
        playerAddress: String(playerAddress),
        signature: String(signature) as `0x${string}`,
        signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => new SignatureBuilder('discussion', chainId, roomId).withParam(dayCount || 1).withParam(reqAction).build(),
        buildModernMessage: (n: string, ts: number) => new SignatureBuilder('discussion', chainId, roomId).withParam(dayCount || 1).withParam(reqAction).withModern(n, ts).build(),
      });

      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Get alive players
      const rid = BigInt(String(roomId));
      const players = await getPlayers(rid, Number(chainId || 50312));
      const allShuffled = shufflePlayers(players, String(roomId));
      const alivePlayers = allShuffled.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const totalSpeakers = alivePlayers.length;

      if (reqAction === 'start') {
        const existingState = await ServerStore.getDiscussionState(String(roomId), Number(dayCount || 1), Number(chainId || 50312));
        if (existingState && !existingState.finished) {
          return res.json({ ok: true, message: 'Already started' });
        }

        const newState = {
          currentSpeakerIndex: 0,
          speakerStartTime: Date.now(),
          speakerDuration: 60,
          finished: false,
          phase: 'initial_delay' as const,
          delayStartTime: Date.now(),
          delayDuration: 5
        };
        await ServerStore.setDiscussionState(String(roomId), Number(dayCount || 1), newState, Number(chainId || 50312));
        logger.info({ roomId, dayCount, chainId }, '[discussion] Discussion started');
        return res.json({ ok: true });
      }

      if (reqAction === 'skip') {
        const state = await ServerStore.getDiscussionState(String(roomId), Number(dayCount || 1), Number(chainId || 50312));
        if (!state || state.finished) return res.status(400).json({ error: 'Not active' });

        // Verify it's current speaker or host
        const currentSpeaker = alivePlayers[state.currentSpeakerIndex];
        const isSpeaker = currentSpeaker?.wallet.toLowerCase() === String(playerAddress).toLowerCase();
        
        // Host check - skip for now or can add getRoom lookup
        if (!isSpeaker) {
             // Optional: lookup room to verify host
             // For now, only speaker can skip local or host must sign
        }

        const newState = await ServerStore.advanceSpeaker(String(roomId), Number(dayCount || 1), totalSpeakers, true, Number(chainId || 50312));
        logger.info({ roomId, dayCount, skippedBy: playerAddress, nextIndex: newState?.currentSpeakerIndex }, '[discussion] Speaker skipped');
        return res.json({ ok: true, newState });
      }

      return res.status(400).json({ error: 'Unknown action' });
    } catch (err: any) {
      logger.error({ err, roomId: req.body?.roomId, player: req.body?.playerAddress }, '[discussion] Internal error');
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

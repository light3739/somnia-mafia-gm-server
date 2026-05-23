/**
 * routes/discussionRoutes.ts
 * Standardized routes for turn-based speaking during DAY phase.
 */
import { Router } from 'express';
import { getPlayers, getRoom, FLAGS } from '../chain.js';
import { ServerStore } from '../services/serverStore.js';
import { shufflePlayers } from '../services/discussionTurns.js';
import type { GMStore } from '../stores/index.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { SignatureBuilder } from '../auth/SignatureBuilder.js';

import { logger } from '../utils/logger.js';
import { wsManager } from '../ws/wsManager.js';
import { turnController } from '../agents/turnController.js';

/** Fire-and-forget: tell the agent turn-controller the speaker changed so an
 *  agent whose turn it now is can speak. No-op until turnController.configure()
 *  runs at agent-subsystem startup (so agent-disabled deployments do nothing). */
export function notifySpeakerChanged(
  roomId: string | number,
  chainId: number,
  dayCount: number
): void {
  void turnController
    .onSpeakerChanged(Number(chainId), String(roomId), Number(dayCount))
    .catch(() => undefined);
}

export interface DiscussionRoutesContext {
  store: GMStore;
  verifyAuthorizedSignature: any;
  actionLimiter: RateLimitRequestHandler;
  pollLimiter: RateLimitRequestHandler;
}

export function createDiscussionRoutes(ctx: DiscussionRoutesContext) {
  const router = Router();
  const { store, verifyAuthorizedSignature, actionLimiter, pollLimiter } = ctx;

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
            if (newState) {
              state = newState;
              // Push auto-advance to WS clients
              const nextSpeaker = alivePlayers[newState.currentSpeakerIndex];
              wsManager.broadcastToRoom(String(roomId), Number(chainId || 50312), {
                type: 'discussion-update',
                data: { currentSpeakerAddress: nextSpeaker?.wallet || null, currentSpeakerIndex: newState.currentSpeakerIndex, phase: newState.phase, finished: newState.finished },
              });
              notifySpeakerChanged(String(roomId), Number(chainId || 50312), Number(dayCount || 1));
            }
          }
        } else if (state.phase === 'initial_delay') {
          const delayElapsed = (Date.now() - (state.delayStartTime || 0)) / 1000;
          const delayDuration = state.delayDuration || 5;
          if (delayElapsed >= delayDuration) {
            const newState = await ServerStore.advanceSpeaker(String(roomId), Number(dayCount || 1), totalSpeakers, false, Number(chainId || 50312));
            if (newState) {
              state = newState;
              const nextSpeaker = alivePlayers[newState.currentSpeakerIndex];
              wsManager.broadcastToRoom(String(roomId), Number(chainId || 50312), {
                type: 'discussion-update',
                data: { currentSpeakerAddress: nextSpeaker?.wallet || null, currentSpeakerIndex: newState.currentSpeakerIndex, phase: newState.phase, finished: newState.finished },
              });
              notifySpeakerChanged(String(roomId), Number(chainId || 50312), Number(dayCount || 1));
            }
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

        // Push discussion start to WS clients
        const firstSpeaker = alivePlayers[0];
        wsManager.broadcastToRoom(String(roomId), Number(chainId || 50312), {
          type: 'discussion-update',
          data: { currentSpeakerAddress: firstSpeaker?.wallet || null, currentSpeakerIndex: 0, phase: 'initial_delay', finished: false },
        });
        notifySpeakerChanged(String(roomId), Number(chainId || 50312), Number(dayCount || 1));

        return res.json({ ok: true });
      }

      if (reqAction === 'skip') {
        const state = await ServerStore.getDiscussionState(String(roomId), Number(dayCount || 1), Number(chainId || 50312));
        if (!state || state.finished) return res.status(400).json({ error: 'Not active' });

        // Verify requester is alive
        const isAlive = alivePlayers.some((p: any) => p.wallet.toLowerCase() === String(playerAddress).toLowerCase());
        if (!isAlive) return res.status(403).json({ error: 'Dead players cannot skip' });

        // Verify it's current speaker OR room host
        const currentSpeaker = alivePlayers[state.currentSpeakerIndex];
        const isSpeaker = currentSpeaker?.wallet.toLowerCase() === String(playerAddress).toLowerCase();
        let isHost = false;
        const effectiveChainId = Number(chainId || 50312);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const room = await getRoom(rid, effectiveChainId);
            isHost = (room.host as string).toLowerCase() === String(playerAddress).toLowerCase();
            break;
          } catch (err) {
            logger.warn({ err: (err as any)?.message, roomId, playerAddress, attempt }, '[discussion] getRoom RPC failed during host check');
          }
        }
        if (!isSpeaker && !isHost) return res.status(403).json({ error: 'Only current speaker or host can skip' });

        const newState = await ServerStore.advanceSpeaker(String(roomId), Number(dayCount || 1), totalSpeakers, true, Number(chainId || 50312));
        logger.info({ roomId, dayCount, skippedBy: playerAddress, nextIndex: newState?.currentSpeakerIndex }, '[discussion] Speaker skipped');

        // Push skip to WS clients
        if (newState) {
          const nextSpeaker = alivePlayers[newState.currentSpeakerIndex];
          wsManager.broadcastToRoom(String(roomId), Number(chainId || 50312), {
            type: 'discussion-update',
            data: { currentSpeakerAddress: nextSpeaker?.wallet || null, currentSpeakerIndex: newState.currentSpeakerIndex, phase: newState.phase, finished: newState.finished },
          });
          notifySpeakerChanged(String(roomId), Number(chainId || 50312), Number(dayCount || 1));
        }

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

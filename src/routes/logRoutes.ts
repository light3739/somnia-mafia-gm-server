import express from 'express';
import { ServerStore } from '../services/serverStore.js';
import { logger } from '../utils/logger.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

export function createLogRoutes(ctx: { pollLimiter: RateLimitRequestHandler }) {
    const router = express.Router();

    /**
     * Get all logs for a room.
     * Rate-limited to prevent enumeration of active rooms.
     */
    router.get('/logs/:roomId', ctx.pollLimiter, async (req, res) => {
        try {
            const roomId = req.params.roomId;
            const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
            const logs = await ServerStore.getGameLogs(roomId, chainId);
            res.json({ logs });
        } catch (err: any) {
            logger.error({ err }, '[logRoutes] Error fetching logs');
            res.status(500).json({ error: 'Failed to fetch logs' });
        }
    });

    /**
     * Get all logs for a room with explicit chainId.
     */
    router.get('/logs/:chainId/:roomId', ctx.pollLimiter, async (req, res) => {
        try {
            const { chainId, roomId } = req.params;
            const logs = await ServerStore.getGameLogs(roomId, Number(chainId));
            res.json({ logs });
        } catch (err: any) {
            logger.error({ err }, '[logRoutes] Error fetching logs (explicit chain)');
            res.status(500).json({ error: 'Failed to fetch logs' });
        }
    });

    return router;
}

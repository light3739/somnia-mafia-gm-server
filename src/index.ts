/**
 * Mafia GM Server - Multi-Chain Edition
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import { GMStore } from './stores/index.js';
import { connectRedis, getRedis } from './redis.js';
import { createAuthService } from './auth/verifySignature.js';
import { bootstrap } from './startup/bootstrap.js';

// Route creators
import { createRoomRoutes } from './routes/roomRoutes.js';
import { createEciesRoutes } from './routes/eciesRoutes.js';
import { createNightRoutes } from './routes/nightRoutes.js';
import { createWinRoutes } from './routes/winRoutes.js';
import { createDiscussionRoutes } from './routes/discussionRoutes.js';
import { createSessionRoutes } from './routes/sessionRoutes.js';
import { createAvatarRoutes } from './routes/avatarRoutes.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Memory Store & Security
const store = new GMStore();
const auth = createAuthService({ store, redis: getRedis() });

app.use(cors());
app.set('trust proxy', 1); // Enable correct IP detection behind Nginx/Cloudflare
app.use(express.json({ limit: '10mb' }));

// Rate Limiting
const pollLimiter = rateLimit({ windowMs: 1000, max: 20, message: { error: 'Too many requests' } });
const actionLimiter = rateLimit({ windowMs: 1000, max: 10, message: { error: 'Action rate limit exceeded' } });
const heavyLimiter = rateLimit({ windowMs: 20000, max: 15, message: { error: 'Heavy action rate limit exceeded' } });

// Health Check
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Initialize Routes
const routesCtx = { store, verifyAuthorizedSignature: auth.verifyAuthorizedSignature, actionLimiter, pollLimiter, heavyLimiter, redis: getRedis() };

app.use(createRoomRoutes(routesCtx as any));
app.use(createEciesRoutes(routesCtx as any));
app.use(createNightRoutes(routesCtx as any));
app.use(createWinRoutes(routesCtx as any));
app.use(createDiscussionRoutes(routesCtx as any));
app.use(createSessionRoutes(routesCtx as any));
app.use(createAvatarRoutes(routesCtx as any));

// Lifecycle
async function start() {
  console.log('[main] Starting Mafia GM Server...');
  await connectRedis();
  const redis = getRedis();
  
  if (redis) {
    console.log('[main] Bootstrapping from Redis...');
    await bootstrap(store, redis);
  } else {
    console.warn('[main] Redis not available, starting with empty memory.');
  }

  app.listen(port, () => {
    console.log(`[main] GM Server listening on port ${port}`);
  });
}

start().catch(err => {
  console.error('[main] Fatal crash during startup:', err);
  process.exit(1);
});

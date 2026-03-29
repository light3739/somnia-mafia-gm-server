/**
 * index.ts — GM Server (Full DI Orchestrator)
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { assertChainConfigOrThrow } from './chain.js';
import { connectRedis, getRedis } from './redis.js';
import { GMStore } from './stores/index.js';
import { createAuthService } from './auth/verifySignature.js';
import { createSessionRoutes } from './routes/sessionRoutes.js';
import { createRoomRoutes } from './routes/roomRoutes.js';
import { createNightRoutes } from './routes/nightRoutes.js';
import { createEciesRoutes } from './routes/eciesRoutes.js';
import { createWinRoutes } from './routes/winRoutes.js';
import { bootstrap } from './startup/bootstrap.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// ─── DI container instantiation ─────────────────────────────
const store = new GMStore();

// ─── Rate Limiters ──────────────────────────────────────────
const pollLimiter = rateLimit({
  windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many polling requests' },
});
const actionLimiter = rateLimit({
  windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many action requests' },
});
const heavyLimiter = rateLimit({
  windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many heavy requests' },
});

async function start(): Promise<void> {
  try {
    await assertChainConfigOrThrow();
    await connectRedis();
    const redis = getRedis();

    // 1. Auth service setup (injected store & redis)
    const { verifyAuthorizedSignature } = createAuthService({ store, redis });

    // 2. Bootstrap setup (async state restore)
    await bootstrap(store, redis);

    // 3. Route Injection
    app.use(createSessionRoutes({ store, redis, actionLimiter }));
    app.use(createRoomRoutes({ store, redis, verifyAuthorizedSignature, actionLimiter, pollLimiter }));
    app.use(createNightRoutes({ store, redis, verifyAuthorizedSignature, actionLimiter, pollLimiter, heavyLimiter }));
    app.use(createEciesRoutes({ store, redis, verifyAuthorizedSignature, actionLimiter, pollLimiter }));
    app.use(createWinRoutes({ store, pollLimiter, heavyLimiter }));

    const PORT = Number(process.env.PORT) || 3001;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎭 Mafia GM Server (Full DI) running on port ${PORT}`);
      console.log(`   Health: http://0.0.0.0:${PORT}/health\n`);
    });
  } catch (error: any) {
    console.error('[startup] Failed to start:', error?.message || error);
    process.exit(1);
  }
}

void start();

/**
 * index.ts — GM Server entry point
 *
 * Architecture:
 *   stores/        — in-memory Maps (eciesPubkeys, sraSKeys, resolvedRoles, …)
 *   crypto/sra.ts  — SRA modular exponentiation helpers
 *   auth/          — signature verification + session key resolution
 *   routes/
 *     sessionRoutes — GET /health, POST /register-session
 *     roomRoutes    — POST /room-password, POST /request-join, GET /room/:id
 *     nightRoutes   — POST /night-action, /skip, /resolve-night, GET /night-status
 *     eciesRoutes   — POST /register-pubkey, /submit-sra-key, GET /my-role, /room-roles, /mafia-members
 *     winRoutes     — GET /win-check, POST /end-game-zk, POST /hash-role
 *   startup/        — Redis restoration + night timer rehydration
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { assertChainConfigOrThrow } from './chain.js';
import { connectRedis } from './redis.js';
import { createSessionRoutes } from './routes/sessionRoutes.js';
import { createRoomRoutes } from './routes/roomRoutes.js';
import { createNightRoutes } from './routes/nightRoutes.js';
import { createEciesRoutes } from './routes/eciesRoutes.js';
import { createWinRoutes } from './routes/winRoutes.js';
import { bootstrap } from './startup/bootstrap.js';

// ─── App ───────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// ─── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Rate Limiters ──────────────────────────────────────────
const pollLimiter = rateLimit({
  windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many polling requests, please wait.' },
});
const actionLimiter = rateLimit({
  windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many action requests, slow down.' },
});
const heavyLimiter = rateLimit({
  windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many heavy requests, please wait.' },
});

// ─── Routes ────────────────────────────────────────────────
app.use(createSessionRoutes(actionLimiter));
app.use(createRoomRoutes(actionLimiter, pollLimiter));
app.use(createNightRoutes(actionLimiter, pollLimiter, heavyLimiter));
app.use(createEciesRoutes(actionLimiter, pollLimiter));
app.use(createWinRoutes(pollLimiter, heavyLimiter));

// ─── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;

async function start(): Promise<void> {
  try {
    await assertChainConfigOrThrow();
    await connectRedis();
    await bootstrap();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎭 Mafia GM Server running on port ${PORT}`);
      console.log(`   Health: http://0.0.0.0:${PORT}/health\n`);
    });
  } catch (error: any) {
    console.error('[startup] Failed to start GM server:', error?.message || error);
    process.exit(1);
  }
}

void start();

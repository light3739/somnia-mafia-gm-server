/**
 * createTestApp — Builds an Express app with injectable mocks for integration tests.
 *
 * Mirrors src/index.ts but replaces Redis, on-chain calls, and rate limiters
 * with test-friendly versions. Each test gets a fresh app + store.
 */
import express from 'express';
import { GMStore } from '../../src/stores/index.js';
import { createEciesRoutes } from '../../src/routes/eciesRoutes.js';
import { createNightRoutes } from '../../src/routes/nightRoutes.js';
import { createAvatarRoutes } from '../../src/routes/avatarRoutes.js';
import { createSessionRoutes } from '../../src/routes/sessionRoutes.js';
import { createDiscussionRoutes } from '../../src/routes/discussionRoutes.js';
import { createRoomRoutes } from '../../src/routes/roomRoutes.js';
import { createWinRoutes } from '../../src/routes/winRoutes.js';
import { Role } from '../../src/types/contract.js';

// No-op rate limiter for tests
const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

interface TestAppOptions {
  /** Override verifyAuthorizedSignature to always succeed for a given signer. */
  autoAuthSigner?: string;
  /** Pre-populate resolved roles for a room. */
  roles?: { roomKey: string; roles: Map<string, Role> };
  /** Mock getRoom return value. */
  mockGetRoom?: (roomId: bigint, chainId?: number) => any;
  /** Mock getPlayers return value. */
  mockGetPlayers?: (roomId: bigint, chainId?: number) => any;
}

export function createTestApp(options: TestAppOptions = {}) {
  const store = new GMStore();
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Pre-populate roles if provided
  if (options.roles) {
    store.resolvedRoles.set(options.roles.roomKey, options.roles.roles);
  }

  // Auto-auth: always succeeds with the given signer address
  const verifyAuthorizedSignature = async (params: any) => {
    if (options.autoAuthSigner) {
      return { ok: true as const, signer: options.autoAuthSigner };
    }
    return { ok: false as const, error: 'Auth disabled in test', status: 401 };
  };

  const routesCtx = {
    store,
    verifyAuthorizedSignature,
    actionLimiter: noopLimiter,
    pollLimiter: noopLimiter,
    heavyLimiter: noopLimiter,
    redis: null,
  };

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Mount routes
  app.use(createEciesRoutes(routesCtx as any));
  app.use(createNightRoutes(routesCtx as any));
  app.use(createAvatarRoutes(routesCtx as any));
  app.use(createSessionRoutes(routesCtx as any));
  app.use(createDiscussionRoutes(routesCtx as any));
  app.use(createRoomRoutes(routesCtx as any));
  app.use(createWinRoutes(routesCtx as any));

  return { app, store };
}

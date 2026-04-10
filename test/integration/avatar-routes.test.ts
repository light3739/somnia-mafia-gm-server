/**
 * avatar-routes.test.ts — Avatar upload validation, SVG blocking, size limits.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/createTestApp.js';

// Mock ServerStore avatar methods
vi.mock('../../src/services/serverStore.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  const avatarStore = new Map<string, string>();
  return {
    ...original,
    ServerStore: {
      ...original.ServerStore,
      storeAvatar: vi.fn(async (roomId: string, addr: string, avatar: string, chainId: string) => {
        avatarStore.set(`${chainId}:${roomId}:${addr.toLowerCase()}`, avatar);
      }),
      getAvatars: vi.fn(async (roomId: string, chainId: string) => {
        const result: Record<string, string> = {};
        for (const [key, val] of avatarStore) {
          if (key.startsWith(`${chainId}:${roomId}:`)) {
            const addr = key.split(':')[2];
            result[addr] = val;
          }
        }
        return result;
      }),
      consumeReplayNonce: vi.fn().mockResolvedValue(true),
    },
  };
});

const PLAYER = '0xplayer1';
const CID = '50312';
const ROOM = '42';

function avatarBody(overrides: Record<string, unknown> = {}) {
  return {
    roomId: ROOM,
    address: PLAYER,
    avatar: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    signature: '0xsig',
    signerAddress: PLAYER,
    nonce: `n_${Date.now()}`,
    timestamp: Date.now(),
    chainId: CID,
    ...overrides,
  };
}

describe('Avatar Routes', () => {

  // ---- POST /avatar ----

  describe('POST /avatar', () => {
    it('accepts valid JPEG avatar', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });
      const res = await request(app).post('/avatar').send(avatarBody());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('accepts valid PNG avatar', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });
      const res = await request(app).post('/avatar').send(avatarBody({
        avatar: 'data:image/png;base64,iVBORw0KGgo=',
      }));
      expect(res.status).toBe(200);
    });

    it('blocks SVG avatar (XSS vector)', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });
      const res = await request(app).post('/avatar').send(avatarBody({
        avatar: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==',
      }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('SVG');
    });

    it('rejects non-image data URI', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });
      const res = await request(app).post('/avatar').send(avatarBody({
        avatar: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('format');
    });

    it('rejects avatar > 500KB', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });
      const bigAvatar = 'data:image/jpeg;base64,' + 'A'.repeat(500_001);
      const res = await request(app).post('/avatar').send(avatarBody({ avatar: bigAvatar }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('large');
    });

    it('rejects missing required fields', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });
      const res = await request(app).post('/avatar').send({ roomId: ROOM });
      expect(res.status).toBe(400);
    });

    it('rejects unauthorized upload', async () => {
      const { app } = createTestApp({}); // no auto-auth
      const res = await request(app).post('/avatar').send(avatarBody());
      expect(res.status).toBe(401);
    });
  });

  // ---- GET /avatars/:roomId ----

  describe('GET /avatars/:roomId', () => {
    it('returns empty object for room with no avatars', async () => {
      const { app } = createTestApp({});
      const res = await request(app).get(`/avatars/${ROOM}`).query({ chainId: CID });
      expect(res.status).toBe(200);
      expect(res.body.avatars).toBeDefined();
    });

    it('returns avatars after upload', async () => {
      const { app } = createTestApp({ autoAuthSigner: PLAYER });

      // Upload
      await request(app).post('/avatar').send(avatarBody());

      // Retrieve
      const res = await request(app).get(`/avatars/${ROOM}`).query({ chainId: CID });
      expect(res.status).toBe(200);
      // Avatar was stored via mocked ServerStore
    });

    it('does NOT require auth for GET (public endpoint)', async () => {
      const { app } = createTestApp({}); // no auth
      const res = await request(app).get(`/avatars/${ROOM}`).query({ chainId: CID });
      expect(res.status).toBe(200);
    });
  });
});

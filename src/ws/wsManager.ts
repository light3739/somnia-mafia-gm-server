/**
 * ws/wsManager.ts — WebSocket connection manager for GM server.
 *
 * Manages per-room subscriptions and broadcasts game events to connected
 * frontend clients, replacing HTTP polling with server-push.
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { verifyMessage, type Address } from 'viem';
import { logger } from '../utils/logger.js';
import { getSessionKey } from '../chain.js';
import { getRedis } from '../redis.js';

// ── Event protocol ──────────────────────────────────────────────────────────

/** Messages the client sends to the server. */
export interface ClientMessage {
  type: 'join' | 'relay';
  roomId: number;
  chainId: number;
  playerAddress: string;
  /** Auth: signature of `ws-join:chainId:roomId:timestamp` */
  signature?: string;
  /** Auth: address that signed (may differ from playerAddress if session key) */
  signerAddress?: string;
  /** Auth: timestamp (ms) when signature was created */
  timestamp?: number;
  /** For relay messages: the event to broadcast to other players in the room. */
  event?: ServerEvent;
}

/** Messages the server pushes to clients. */
export interface ServerEvent {
  type:
    | 'log'
    | 'phase-change'
    | 'night-resolved'
    | 'discussion-update'
    | 'role-ready'
    | 'win-detected'
    | 'player-update'
    | 'roles-revealed'
    | 'mafia-chat'
    | 'game-signal'
    | 'rematch-invite'
    | 'pong'
    | 'joined'
    | 'error';
  data?: unknown;
}

// ── Internal types ──────────────────────────────────────────────────────────

interface SocketMeta {
  roomKey: string | null;
  playerAddress: string | null;
  alive: boolean;
  /** Relay rate limiting: timestamp of last relay */
  lastRelayTs: number;
  /** Relay count in current window */
  relayCount: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

// ── Manager singleton ───────────────────────────────────────────────────────

class WsManager {
  /** roomKey → set of sockets subscribed to that room */
  private rooms = new Map<string, Set<WebSocket>>();

  /** playerAddress (lower) → socket for targeted messages */
  private playerSockets = new Map<string, WebSocket>();

  /** roomKey → set of mafia player addresses (lower). Used to filter mafia-chat relay. */
  private roomMafia = new Map<string, Set<string>>();

  /** per-socket metadata */
  private meta = new WeakMap<WebSocket, SocketMeta>();

  /** Session cache reference for verifying session key ownership on WS join */
  private sessionCache: Map<string, { sessionAddress: string }> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Provide session cache so WS auth can resolve session keys.
   * Called once at startup from index.ts.
   */
  setSessionCache(cache: Map<string, { sessionAddress: string }>) {
    this.sessionCache = cache;
  }

  /**
   * Attach to a WebSocketServer and start accepting connections.
   * Call once at startup after creating the WSS instance.
   */
  attach(wss: WebSocketServer) {
    wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      this.handleConnection(ws);
    });

    // Heartbeat: detect stale connections
    this.heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        const m = this.meta.get(ws);
        if (m && !m.alive) {
          logger.debug('[WS] Terminating stale connection');
          ws.terminate();
          continue;
        }
        if (m) m.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    wss.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    });

    logger.info('[WS] Manager attached and listening');
  }

  // ── Connection handling ─────────────────────────────────────────────────

  private handleConnection(ws: WebSocket) {
    const m: SocketMeta = { roomKey: null, playerAddress: null, alive: true, lastRelayTs: 0, relayCount: 0 };
    this.meta.set(ws, m);

    ws.on('pong', () => {
      m.alive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        this.handleClientMessage(ws, msg).catch((err) => {
          logger.error({ err }, '[WS] Error handling message');
        });
      } catch {
        this.send(ws, { type: 'error', data: 'Invalid message format' });
      }
    });

    ws.on('close', () => this.cleanup(ws));
    ws.on('error', (err) => {
      logger.error({ err }, '[WS] Socket error');
      this.cleanup(ws);
    });
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage) {
    // Relay: client sends an event to broadcast to other players in the room.
    // For mafia-chat: only relay to other mafia members (not the whole room)
    // to avoid leaking even the existence of messages to non-mafia players.
    if (msg.type === 'relay') {
      const m = this.meta.get(ws);
      if (!m?.roomKey || !msg.event) return;

      // Rate limit: max 10 relays per second per client
      const now = Date.now();
      if (now - m.lastRelayTs > 1000) {
        m.lastRelayTs = now;
        m.relayCount = 0;
      }
      if (++m.relayCount > 10) return; // silently drop

      if (msg.event.type === 'mafia-chat') {
        // Mafia-only relay: send to players whose address is in the mafiaMembers set
        const mafiaSet = this.roomMafia.get(m.roomKey);
        if (!mafiaSet) return; // No mafia registered yet — drop silently
        const sockets = this.rooms.get(m.roomKey);
        if (!sockets) return;
        const payload = JSON.stringify(msg.event);
        for (const peer of sockets) {
          if (peer === ws) continue;
          const peerMeta = this.meta.get(peer);
          if (peerMeta?.playerAddress && mafiaSet.has(peerMeta.playerAddress) && peer.readyState === WebSocket.OPEN) {
            peer.send(payload);
          }
        }
      } else {
        // Generic relay: broadcast to everyone in the room except sender
        const sockets = this.rooms.get(m.roomKey);
        if (!sockets) return;
        const payload = JSON.stringify(msg.event);
        for (const peer of sockets) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(payload);
          }
        }
      }
      return;
    }

    if (msg.type === 'join') {
      const { roomId, chainId, playerAddress, signature, signerAddress, timestamp } = msg;

      if (!roomId || !chainId || !playerAddress) {
        this.send(ws, { type: 'error', data: 'Missing roomId, chainId, or playerAddress' });
        return;
      }

      // Verify signature (required)
      if (!signature || !timestamp) {
        this.send(ws, { type: 'error', data: 'Missing signature or timestamp' });
        ws.close(4001, 'Unauthorized');
        return;
      }

      // Check timestamp freshness (±60s)
      const age = Date.now() - timestamp;
      if (age > 60_000 || age < -10_000) {
        this.send(ws, { type: 'error', data: 'Timestamp expired' });
        ws.close(4001, 'Unauthorized');
        return;
      }

      const expectedMessage = `ws-join:${chainId}:${roomId}:${timestamp}`;
      const expectedSigner = (signerAddress || playerAddress).toLowerCase();

      try {
        const valid = await verifyMessage({
          address: expectedSigner as `0x${string}`,
          message: expectedMessage,
          signature: signature as `0x${string}`,
        });

        if (!valid) {
          this.send(ws, { type: 'error', data: 'Invalid signature' });
          ws.close(4001, 'Unauthorized');
          return;
        }

        // If signer differs from player, verify it's a valid session key.
        // Check: local cache → Redis → on-chain (same fallback chain as
        // verifySignature). The /register-session HTTP call was removed from
        // the client to avoid a double MetaMask popup, so the cache is often
        // empty on first WS connect. Without the fallback the first join
        // always got 4001 and cost 5-15s of WS downtime.
        if (expectedSigner !== playerAddress.toLowerCase()) {
          const cacheKey = `${chainId}:${playerAddress.toLowerCase()}`;
          let cached = this.sessionCache?.get(cacheKey);

          // Redis fallback
          if (!cached || cached.sessionAddress.toLowerCase() !== expectedSigner) {
            try {
              const redis = getRedis();
              if (redis) {
                const stored = await redis.get(`gm:session:${cacheKey}`);
                if (stored) {
                  const parsed = JSON.parse(stored);
                  if (parsed?.sessionAddress?.toLowerCase() === expectedSigner) {
                    cached = parsed;
                    this.sessionCache?.set(cacheKey, cached!);
                  }
                }
              }
            } catch { /* Redis unavailable — continue to on-chain */ }
          }

          // On-chain fallback (single attempt — WS join should be fast)
          if (!cached || cached.sessionAddress.toLowerCase() !== expectedSigner) {
            try {
              const session = await getSessionKey(playerAddress.toLowerCase() as Address, Number(chainId)) as any;
              const sessionAddr = String(session.sessionAddress || '').toLowerCase();
              const isActive = Boolean(session.isActive);
              const expiresAt = Number(session.expiresAt || 0);
              const isExpired = expiresAt > 0 && expiresAt < Math.floor(Date.now() / 1000);

              if (sessionAddr === expectedSigner && isActive && !isExpired) {
                cached = { sessionAddress: expectedSigner, roomId: String(roomId), chainId: Number(chainId) };
                this.sessionCache?.set(cacheKey, cached);
                // Also persist to Redis for faster future lookups
                try {
                  const redis = getRedis();
                  if (redis) {
                    await redis.set(`gm:session:${cacheKey}`, JSON.stringify({
                      sessionAddress: expectedSigner,
                      roomId: String(roomId),
                      chainId: Number(chainId),
                    }), 'EX', 86400);
                  }
                } catch { /* non-critical */ }
                logger.info({ cacheKey, sessionAddress: expectedSigner }, '[WS] Session key verified on-chain and cached');
              }
            } catch (e) {
              logger.warn({ err: e, cacheKey }, '[WS] On-chain session key check failed');
            }
          }

          if (!cached || cached.sessionAddress.toLowerCase() !== expectedSigner) {
            this.send(ws, { type: 'error', data: 'Session key not recognized' });
            ws.close(4001, 'Unauthorized');
            return;
          }
        }
      } catch {
        this.send(ws, { type: 'error', data: 'Signature verification failed' });
        ws.close(4001, 'Unauthorized');
        return;
      }

      // Clean up previous subscription if re-joining
      this.cleanup(ws);

      const roomKey = `${chainId}:${roomId}`;
      const addrLower = playerAddress.toLowerCase();
      const m = this.meta.get(ws)!;
      m.roomKey = roomKey;
      m.playerAddress = addrLower;
      m.alive = true;

      // Add to room set
      if (!this.rooms.has(roomKey)) {
        this.rooms.set(roomKey, new Set());
      }
      this.rooms.get(roomKey)!.add(ws);

      // Map player address → socket (last connection wins)
      this.playerSockets.set(addrLower, ws);

      const roomSize = this.rooms.get(roomKey)!.size;
      logger.info(`[WS] Player ${addrLower} joined room ${roomKey} (${roomSize} connected)`);

      this.send(ws, { type: 'joined', data: { roomKey, playerAddress: addrLower } });
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  private cleanup(ws: WebSocket) {
    const m = this.meta.get(ws);
    if (!m) return;

    if (m.roomKey) {
      const roomSet = this.rooms.get(m.roomKey);
      if (roomSet) {
        roomSet.delete(ws);
        if (roomSet.size === 0) this.rooms.delete(m.roomKey);
      }
    }

    if (m.playerAddress) {
      // Only remove from playerSockets if it's still pointing at this ws
      if (this.playerSockets.get(m.playerAddress) === ws) {
        this.playerSockets.delete(m.playerAddress);
      }
    }

    m.roomKey = null;
    m.playerAddress = null;
  }

  // ── Broadcasting ────────────────────────────────────────────────────────

  /**
   * Send an event to ALL clients subscribed to a given room.
   */
  broadcastToRoom(roomId: string | number, chainId: number, event: ServerEvent) {
    const roomKey = `${chainId}:${roomId}`;
    const sockets = this.rooms.get(roomKey);
    if (!sockets || sockets.size === 0) return;

    const payload = JSON.stringify(event);
    let sent = 0;
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        sent++;
      }
    }

    logger.debug(`[WS] Broadcast ${event.type} to room ${roomKey}: ${sent}/${sockets.size} delivered`);
  }

  /**
   * Send a targeted event to a specific player (e.g. role-ready).
   */
  sendToPlayer(playerAddress: string, event: ServerEvent) {
    const ws = this.playerSockets.get(playerAddress.toLowerCase());
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
      logger.debug(`[WS] Sent ${event.type} to player ${playerAddress.slice(0, 8)}...`);
    }
  }

  // ── Mafia membership ─────────────────────────────────────────────────

  /**
   * Register which players are mafia in a room. Called by eciesRoutes
   * after roles are resolved. Enables filtered mafia-chat relay.
   */
  setRoomMafia(roomId: string | number, chainId: number, mafiaAddresses: string[]) {
    const roomKey = `${chainId}:${roomId}`;
    this.roomMafia.set(roomKey, new Set(mafiaAddresses.map(a => a.toLowerCase())));
    logger.debug(`[WS] Registered ${mafiaAddresses.length} mafia members for room ${roomKey}`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private send(ws: WebSocket, event: ServerEvent) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /** How many WS clients are currently connected across all rooms. */
  get totalConnections(): number {
    let total = 0;
    for (const s of this.rooms.values()) total += s.size;
    return total;
  }

  /** How many rooms have at least one subscriber. */
  get activeRooms(): number {
    return this.rooms.size;
  }
}

/** Singleton instance — import and use everywhere in the GM server. */
export const wsManager = new WsManager();

import { DIAMOND_ABI, getChainConfig, somniaTestnet } from '../chain.js';
import { ServerStore, type GameLogEntry } from './serverStore.js';
import { logger } from '../utils/logger.js';
import { wsManager } from '../ws/wsManager.js';

// Nickname cache: chainId -> roomId -> address -> nickname
// Populated from PlayerJoined events so we can resolve names in later events.
// Survives server restarts by hydrating from stored Redis logs on first access.
const nicknameCache = new Map<number, Map<string, Map<string, string>>>();

// Tracks rooms already hydrated so we don't re-read Redis on every event
const hydratedRooms = new Set<string>(); // key: `${chainId}:${roomId}`

function cacheNickname(chainId: number, roomId: string, address: string, nickname: string) {
    if (!nicknameCache.has(chainId)) nicknameCache.set(chainId, new Map());
    const chainMap = nicknameCache.get(chainId)!;
    if (!chainMap.has(roomId)) chainMap.set(roomId, new Map());
    chainMap.get(roomId)!.set(address.toLowerCase(), nickname);
}

function resolveNickname(chainId: number, roomId: string, address: string): string {
    return nicknameCache.get(chainId)?.get(roomId)?.get(address.toLowerCase())
        ?? `${address.slice(0, 6)}...`;
}

/**
 * Hydrate the nickname cache from already-stored logs (e.g. after server restart).
 * Reads PlayerJoined entries from Redis and populates address->nickname mapping.
 * Safe to call multiple times — skips rooms already processed.
 */
async function hydrateNicknameCacheForRoom(chainId: number, roomId: string): Promise<void> {
    const key = `${chainId}:${roomId}`;
    if (hydratedRooms.has(key)) return;
    hydratedRooms.add(key); // Mark early to avoid parallel duplicate calls

    try {
        const storedLogs = await ServerStore.getGameLogs(roomId, chainId);
        for (const log of storedLogs) {
            if (log.eventType === 'PlayerJoined' && log.eventData?.playerAddress && log.eventData?.playerName) {
                cacheNickname(chainId, roomId, log.eventData.playerAddress, log.eventData.playerName);
            }
        }
        logger.debug(`[LogListener] Hydrated nickname cache for Room ${roomId} (chain ${chainId}): ${storedLogs.length} logs scanned`);
    } catch (err) {
        logger.error({ err }, `[LogListener] Failed to hydrate nickname cache for Room ${roomId}`);
        hydratedRooms.delete(key); // Allow retry next time
    }
}

export class LogListener {
  private static activeListeners: Map<number, any> = new Map();

  static start() {
    this.listenOnChain(somniaTestnet.id);
  }

  private static listenOnChain(chainId: number) {
    const { public: client, diamond } = getChainConfig(chainId);
    
    logger.info(`[LogListener] Starting event listener for chain ${chainId} at ${diamond}`);

    const unwatch = client.watchContractEvent({
      address: diamond,
      abi: DIAMOND_ABI,
      onLogs: (logs: any[]) => {
        for (const log of logs) {
          this.handleEvent(chainId, log).catch(err => {
            logger.error({ err }, `[LogListener] Error handling event ${log.eventName}`);
          });
        }
      }
    });

    this.activeListeners.set(chainId, unwatch);
  }

  private static async handleEvent(chainId: number, log: any) {
    const { eventName, args, transactionHash } = log;
    const roomId = args.roomId?.toString();
    if (!roomId) return;

    // Hydrate nickname cache from Redis on first event per room (handles server restarts)
    await hydrateNicknameCacheForRoom(chainId, roomId);

    logger.info(`[LogListener] Event ${eventName} caught for Room ${roomId} on Chain ${chainId}`);

    const timestamp = Date.now();
    const entryId = `${transactionHash}-${log.logIndex || 0}`;
    
    let message = '';
    let type: GameLogEntry['type'] = 'info';
    let eventType = eventName;
    let eventData: any = {};

    switch (eventName) {
      case 'RoomCreated':
        // Don't log room creation into game feed — it's lobby info
        return;

      case 'PlayerJoined':
        // Cache the nickname for later events
        if (args.player && args.nickname) {
          cacheNickname(chainId, roomId, args.player, args.nickname);
        }
        message = `${args.nickname} joined the room.`;
        type = 'info';
        eventData = { playerName: args.nickname, playerAddress: args.player };
        break;

      case 'GameStarted':
        message = `Game started! Prepare yourselves.`;
        type = 'success';
        break;

      case 'DayStarted':
        type = 'phase';
        message = `Day ${args.dayNumber} has begun.`;
        eventData = { dayNumber: Number(args.dayNumber) };
        break;

      case 'VotingStarted':
        message = `Voting Phase Started. Cast your votes.`;
        type = 'warning';
        eventType = 'VOTING_STARTED';
        break;

      case 'VoteCast': {
        const voterName = resolveNickname(chainId, roomId, args.voter);
        const targetName = resolveNickname(chainId, roomId, args.target);
        message = `${voterName} voted for ${targetName}`;
        type = 'info';
        eventType = 'PLAYER_VOTED';
        eventData = { playerName: voterName, targetName };
        break;
      }

      case 'VotingFinalized':
        if (args.eliminated === '0x0000000000000000000000000000000000000000') {
          message = `Voting Finalized: No one was eliminated.`;
          type = 'warning';
          eventData = { isSafe: true };
        } else {
          const elimName = resolveNickname(chainId, roomId, args.eliminated);
          message = `Voting Finalized: ${elimName} was eliminated!`;
          type = 'danger';
          eventData = { isEliminated: true, playerName: elimName };
        }
        eventType = 'VOTING_RESULT';
        break;

      case 'NightStarted':
        type = 'night';
        message = `Night has fallen...`;
        eventType = 'NIGHT_FALLS';
        break;

      case 'NightFinalized':
        // Failsafe peaceful path only — LibGame.finalizeNight always emits
        // (0,0) here. Real mafia kills come through NightResolvedByGM below.
        if (!args.killed || args.killed === '0x0000000000000000000000000000000000000000') {
          message = `Night Result: No one died last night.`;
          type = 'success';
          eventData = { isSafe: true };
        } else {
          const killedName = resolveNickname(chainId, roomId, args.killed);
          if (args.killed === args.healed) {
            message = `Night Result: No one died last night.`;
            type = 'success';
            eventData = { isSafe: true };
          } else {
            message = `Night Result: ${killedName} was killed by Mafia!`;
            type = 'danger';
            eventData = { isEliminated: true, playerName: killedName };
          }
        }
        eventType = 'NIGHT_RESULT';
        break;

      case 'NightResolvedByGM': {
        // Real mafia kill path: NightFacet.resolveNightAsGameMaster emits this
        // BEFORE transitionToDay when victim != 0. Previously no NIGHT_RESULT
        // log was produced for kill nights — the morning recap on the next day
        // stayed empty even though the player was clearly dead.
        const killedAddr = args.killed as string | undefined;
        if (!killedAddr || killedAddr === '0x0000000000000000000000000000000000000000') {
          // Defensive: GM should not call this with victim==0, but if it does
          // surface a peaceful result so we don't lose the log entry entirely.
          message = `Night Result: No one died last night.`;
          type = 'success';
          eventData = { isSafe: true };
        } else {
          const killedName = resolveNickname(chainId, roomId, killedAddr);
          message = `Night Result: ${killedName} was killed by Mafia!`;
          type = 'danger';
          eventData = { isEliminated: true, playerName: killedName };
        }
        eventType = 'NIGHT_RESULT';
        break;
      }

      case 'PlayerEliminated':
        // Only log non-night eliminations (night kills are covered by NightFinalized)
        if (args.reason === 'Killed at night') return;
        {
          const elimName = resolveNickname(chainId, roomId, args.player);
          message = `${elimName} eliminated: ${args.reason}`;
          type = 'danger';
        }
        break;

      case 'GameEnded': {
        const winCondition = (args.winCondition as string) || '';
        const lower = winCondition.toLowerCase();
        if (lower.includes('aborted')) {
          // Pre-DAY abort: LibGame.abortPreGame ended the room before DAY,
          // every player (including the one who ghosted) got their buy-in
          // + deposit refunded in full.
          message = 'Game aborted before start — everyone refunded (deposit + buy-in).';
          type = 'warning';
        } else {
          const winner = lower.includes('town') ? 'Town' : lower.includes('mafia') ? 'Mafia' : 'Unknown';
          message = `Game Over! ${winner} wins! (${winCondition})`;
          type = 'success';
        }
        break;
      }

      case 'RoomReturnedToLobby':
        // Legacy event — the old kickAfkAndReturnToLobby path rewound the
        // room back to LOBBY on pre-DAY timeout. The new abortPreGame model
        // ENDs the room outright and emits GameEnded("Aborted pre-game")
        // instead. Kept as a defensive no-op for historical log replay;
        // new contracts never emit this event.
        return;

      default:
        return; // Don't log unknown events
    }

    if (message) {
      const logEntry: GameLogEntry = { id: entryId, message, type, timestamp, eventType, eventData };
      await ServerStore.addGameLog(roomId, logEntry, chainId);

      // Push log to all WS clients in this room
      wsManager.broadcastToRoom(roomId, chainId, { type: 'log', data: logEntry });
    }

    // Push structured events so frontend can react without polling
    switch (eventName) {
      case 'GameStarted':
      case 'DayStarted':
      case 'VotingStarted':
      case 'NightStarted':
      case 'GameEnded':
        wsManager.broadcastToRoom(roomId, chainId, {
          type: 'phase-change',
          data: { event: eventName, dayNumber: eventData?.dayNumber },
        });
        break;

      case 'PlayerJoined':
      case 'PlayerEliminated':
      case 'VoteCast':
      case 'VotingFinalized':
      case 'NightFinalized':
      case 'NightResolvedByGM':
        wsManager.broadcastToRoom(roomId, chainId, {
          type: 'player-update',
          data: { trigger: eventName },
        });
        break;
    }
  }

  static stop() {
    for (const unwatch of this.activeListeners.values()) {
      unwatch();
    }
    this.activeListeners.clear();
  }
}

import { DIAMOND_ABI, getChainConfig, avalancheFuji, somniaTestnet } from '../chain.js';
import { ServerStore, type GameLogEntry } from './serverStore.js';
import { logger } from '../utils/logger.js';

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
    this.listenOnChain(avalancheFuji.id);
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
        message = `Day ${args.dayNumber} has begun.`;
        type = 'phase'  as any;
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
          eventData = { isSafe: true };
          type = 'warning';
        } else {
          const elimName = resolveNickname(chainId, roomId, args.eliminated);
          message = `Voting Finalized: ${elimName} was eliminated!`;
          eventData = { isEliminated: true, playerName: elimName, playerAddress: args.eliminated };
          type = 'danger';
        }
        eventType = 'VOTING_RESULT';
        break;

      case 'NightStarted':
        message = `Night has fallen...`;
        type = 'night' as any;
        eventType = 'NIGHT_FALLS';
        break;

      case 'NightFinalized':
        if (!args.killed || args.killed === '0x0000000000000000000000000000000000000000') {
          message = `Night Result: No one died last night.`;
          eventData = { isSafe: true };
          type = 'success';
        } else {
          const killedName = resolveNickname(chainId, roomId, args.killed);
          const healedAddr = args.healed ? (args.healed as string).toLowerCase() : '0x00';
          const killedAddr = (args.killed as string).toLowerCase();
          if (killedAddr === healedAddr) {
            message = `Night Result: No one died last night.`;
            eventData = { isSafe: true };
            type = 'success';
          } else {
            message = `Night Result: ${killedName} was killed by Mafia!`;
            eventData = { isEliminated: true, playerName: killedName, playerAddress: args.killed };
            type = 'danger';
          }
        }
        eventType = 'NIGHT_RESULT';
        break;

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
        const winner = lower.includes('town') ? 'Town' : lower.includes('mafia') ? 'Mafia' : 'Unknown';
        message = `Game Over! ${winner} wins! (${winCondition})`;
        type = 'success';
        break;
      }

      default:
        return; // Don't log unknown events
    }

    if (message) {
      await ServerStore.addGameLog(roomId, {
        id: entryId,
        message,
        type,
        timestamp,
        eventType,
        eventData
      }, chainId);
    }
  }

  static stop() {
    for (const unwatch of this.activeListeners.values()) {
      unwatch();
    }
    this.activeListeners.clear();
  }
}

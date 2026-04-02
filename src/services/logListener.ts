import { DIAMOND_ABI, getChainConfig, avalancheFuji, somniaTestnet } from '../chain.js';
import { ServerStore, type GameLogEntry } from './serverStore.js';
import { logger } from '../utils/logger.js';
import { formatEther } from 'viem';

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
    const { eventName, args, transactionHash, blockNumber } = log;
    const roomId = args.roomId?.toString();
    if (!roomId) return;

    logger.info(`[LogListener] Event ${eventName} caught for Room ${roomId} on Chain ${chainId}`);

    const timestamp = Date.now();
    const entryId = `${transactionHash}-${log.logIndex || 0}`;
    
    let message = '';
    let type: GameLogEntry['type'] = 'info';
    let eventType = eventName;
    let eventData: any = {};

    switch (eventName) {
      case 'RoomCreated':
        message = `Room "${args.name}" created by ${args.host.slice(0, 6)}... (Max: ${args.maxPlayers} players)`;
        type = 'info';
        break;
      case 'PlayerJoined':
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
        type = 'info';
        eventData = { dayNumber: Number(args.dayNumber) };
        break;
      case 'VotingStarted':
        message = `Voting Phase Started. Discuss and cast your votes.`;
        type = 'warning';
        break;
      case 'VotingFinalized':
        if (args.eliminated === '0x0000000000000000000000000000000000000000') {
          message = `No one was eliminated.`;
          eventData = { isSafe: true };
        } else {
          // In a real scenario, we might want to fetch the nickname for this address
          message = `${args.eliminated.slice(0, 6)}... was eliminated by vote.`;
          eventData = { isEliminated: true, playerAddress: args.eliminated };
        }
        type = 'danger';
        eventType = 'VOTING_RESULT';
        break;
      case 'NightStarted':
        message = `Night has fallen. Role-players, perform your actions.`;
        type = 'info';
        eventType = 'NIGHT_FALLS';
        break;
      case 'NightFinalized':
        if (args.killed === '0x0000000000000000000000000000000000000000') {
          message = `Night Result: No one died.`;
          eventData = { isSafe: true };
        } else {
          message = `Night Result: ${args.killed.slice(0, 6)}... was killed.`;
          eventData = { isEliminated: true, playerAddress: args.killed };
        }
        type = 'danger';
        eventType = 'NIGHT_RESULT';
        break;
      case 'GameEnded':
        message = `Game Over: ${args.winCondition}`;
        type = 'success';
        break;
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

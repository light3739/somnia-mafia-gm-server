import { Role } from '../types/contract.js';
import type { Address } from 'viem';

export interface InvestigationProof {
  targetAddress: Address;
  timestamp: number;
}

export class GMStore {
  // Per room: player address → ECIES public key hex
  public eciesPubkeys = new Map<string, Map<string, string>>();

  // Per room: player address → SRA decryption key
  public sraSKeys = new Map<string, Map<string, string>>();

  // Per room: player address → ECIES-resolved role (enum)
  public resolvedRoles = new Map<string, Map<string, Role>>();

  // Per room: stable player order (address[] in join order)
  public roomPlayerOrder = new Map<string, Address[]>();

  // Per room per night: detective proofs
  public investigationProofs = new Map<string, Map<string, InvestigationProof>>();

  // mainWallet.lower() → { sessionAddress, roomId, chainId }
  public sessionCache = new Map<string, { sessionAddress: string; roomId: number; chainId: number }>();

  // roomId string → chainId number
  public roomChains = new Map<string, number>();

  /** Helper to get or create a nested room map. */
  public getRoomMap<V>(map: Map<string, Map<string, V>>, roomId: string): Map<string, V> {
    let m = map.get(roomId);
    if (!m) { m = new Map(); map.set(roomId, m); }
    return m;
  }
}

/**
 * stores/index.ts — DI Container for all in-memory state.
 */

export interface InvestigationProof {
  targetAddress: string;
  timestamp: number;
}

export class GMStore {
  // Per room: player address → ECIES public key hex
  public eciesPubkeys = new Map<string, Map<string, string>>();

  // Per room: player address → SRA decryption key
  public sraSKeys = new Map<string, Map<string, string>>();

  // Per room: player address → ECIES-resolved role
  public resolvedRoles = new Map<string, Map<string, string>>();

  // Per room: stable player order (address[] in join order)
  public roomPlayerOrder = new Map<string, string[]>();

  // Per room per night: detective proofs
  public investigationProofs = new Map<string, Map<string, InvestigationProof>>();

  // mainWallet.lower() → { sessionAddress, roomId }
  public sessionCache = new Map<string, { sessionAddress: string; roomId: number }>();

  /** Helper to get or create a nested room map. */
  public getRoomMap<V>(map: Map<string, Map<string, V>>, roomId: string): Map<string, V> {
    let m = map.get(roomId);
    if (!m) { m = new Map(); map.set(roomId, m); }
    return m;
  }
}

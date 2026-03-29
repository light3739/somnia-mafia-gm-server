/**
 * stores/index.ts — All in-memory state for the GM server.
 * Centralised here so routes can import without circular deps.
 */

// Per room: player address → ECIES public key hex (65-byte uncompressed P-256)
export const eciesPubkeys = new Map<string, Map<string, string>>();

// Per room: player address → SRA decryption key (bigint as string)
export const sraSKeys = new Map<string, Map<string, string>>();

// Per room: player address → ECIES-resolved role (cached after all SRA keys collected)
export const resolvedRoles = new Map<string, Map<string, string>>();

// Per room: stable player order (address[] in join order)
export const roomPlayerOrder = new Map<string, string[]>();

// Per room per night: detective proofs
export interface InvestigationProof {
  targetAddress: string;
  timestamp: number;
}
export const investigationProofs = new Map<string, Map<string, InvestigationProof>>();

// mainWallet.lower() → { sessionAddress, roomId }
export const sessionCache = new Map<string, { sessionAddress: string; roomId: number }>();

/** Get or create a nested map for a room. */
export function getRoomMap<V>(map: Map<string, Map<string, V>>, roomId: string): Map<string, V> {
  let m = map.get(roomId);
  if (!m) { m = new Map(); map.set(roomId, m); }
  return m;
}

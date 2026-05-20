/**
 * agents/role-resolve.ts — pure SRA deck → role resolution.
 *
 * Extracted from routes/eciesRoutes.ts (/submit-sra-key) so both the live HTTP
 * path and the headless agent pre-game (4j) resolve roles the same way with no
 * HTTP self-call. Pure: decrypt each on-chain deck slot with every player's SRA
 * decryption key (SRA is commutative, so key order is irrelevant), then map the
 * decoded card value to a role. Slot i corresponds to player i — the deck is
 * re-encrypted in place by each shuffler and never re-ordered, so the on-chain
 * player index is the deck index. See SomniaMafia shuffleService.encryptDeck
 * (map-only, no shuffle) and ShuffleAndReveal.handleMyTurn.
 *
 * Side effects (Redis persist, role-sync, WS push) stay with the callers.
 */
import { Role } from "../types/contract.js";
import { sraDecryptCard, roleFromCardValue } from "../crypto/sra.js";

/**
 * @param deck            on-chain revealedDeck (fully multi-encrypted card strings)
 * @param addrsInOrder    player addresses in deck-slot order (slot i = addrsInOrder[i])
 * @param decryptionKeys  every player's SRA decryption exponent (as strings)
 * @param roomId          used for the per-room card offset
 * @returns Map<lowercased address, Role>. Unresolvable slots map to Role.NONE.
 */
export function resolveRolesFromDeck(
  deck: string[],
  addrsInOrder: string[],
  decryptionKeys: string[],
  roomId: number | string | bigint
): Map<string, Role> {
  const roles = new Map<string, Role>();
  addrsInOrder.forEach((addr, i) => {
    if (i >= deck.length) return;
    const decoded = sraDecryptCard(deck[i], decryptionKeys);
    roles.set(addr.toLowerCase(), roleFromCardValue(decoded, roomId));
  });
  return roles;
}

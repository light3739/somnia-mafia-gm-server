/**
 * agents/pregame.ts — PreGameHandler (Task 4j).
 *
 * Agents have no browser, so the shuffle/role logic that each human's client ran
 * (SomniaMafia/services/shuffleService.ts + ShuffleAndReveal.tsx) never executed
 * for agent seats — an all-agent game stalled at SHUFFLING and aborted. This
 * handler ports that flow server-side for agent EOAs (HD-derived, keys held by
 * gm-server) so an all-agent room reaches DAY and the existing DAY/VOTING/NIGHT
 * loop takes over.
 *
 * Two phases:
 *   handleShuffling — SHUFFLING is sequential (one shuffler at a time, gated by
 *     room.currentShufflerIndex). We loop: while the current shuffler is one of
 *     our agents, do that agent's deck commit+reveal, re-read, advance. The first
 *     shuffler deals the role deck (generateDistributedDeck); each subsequent one
 *     re-encrypts the on-chain revealedDeck IN PLACE (no re-order — slot i stays
 *     player i, matching shuffleService.encryptDeck). Stops at a human shuffler
 *     (mixed games, deferred) or when the contract transitions to REVEAL.
 *   handleReveal — REVEAL can fan out. Because the server generated *every*
 *     agent's SRA key, it resolves roles directly from the on-chain deck
 *     (resolveRolesFromDeck) instead of the per-player submit-sra-key dance, then
 *     commitAndConfirmRole per agent → DAY.
 *
 * Idempotency / restart resilience: on-chain flags are the source of truth
 * (DECK_COMMITTED, CONFIRMED_ROLE) — every step checks before sending and tolerates
 * the matching revert. SRA keys + in-flight deck + role salt are persisted in Redis
 * the instant they're created so a restart can resume (spec §8).
 *
 * Test surface: chain + redis are injected, so the whole flow is unit-tested
 * against a faithful in-memory ShuffleFacet model with no chain/RPC.
 */
import type { Redis } from "ioredis";
import {
  toHex,
  type Address,
  type Hex,
  type HDAccount,
} from "viem";
import { logger } from "../utils/logger.js";
import { GamePhase, FLAGS, Role } from "../types/contract.js";
import {
  matchWalletsToAgents,
  type AgentWallet,
} from "./wallets.js";
import {
  getCardOffset,
  generateVerifiedSraKeys,
  encryptDeck,
  generateDistributedDeck,
  generateSalt,
  deckCommitHash,
  type SraKeys,
} from "../crypto/sra.js";
import { resolveRolesFromDeck } from "./role-resolve.js";
import { syncAgentRolesFromResolvedRoles } from "./role-sync.js";
import {
  agentSraKey,
  agentRoleSaltKey,
  agentDeckCommitKey,
  PREGAME_TTL_SECONDS,
} from "./redis-keys.js";
import { eciesEncrypt } from "../ecies.js";
import type { GMStore } from "../stores/index.js";
import { submitSraKey } from "../services/roleResolution.js";
import { ServerStore } from "../services/serverStore.js";
import { calculatePoseidon } from "../zk.js";

// ─── Chain surface ───────────────────────────────────────────────────────────

export interface RoomPregameSnapshot {
  phase: number;
  playersCount: number;
  aliveCount: number;
  currentShufflerIndex: number;
  confirmedCount: number;
  keysSharedCount: number;
  revealedCount: number;
  phaseDeadline: number;
}

export interface PlayerPregameSnapshot {
  wallet: Address;
  flags: number;
  /** On-chain ECIES public key bytes (P-256 uncompressed, hex). May be empty. */
  publicKey: Hex;
}

/**
 * Chain ops the pre-game handler needs. Production impl wraps the viem clients in
 * src/chain.ts (makePreGameChainOps); tests inject a faithful fake.
 */
export interface PreGameChainOps {
  readonly chainId: number;
  readonly diamond: Hex;
  getRoom(roomId: bigint): Promise<RoomPregameSnapshot>;
  getPlayers(roomId: bigint): Promise<readonly PlayerPregameSnapshot[]>;
  getDeck(roomId: bigint): Promise<string[]>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  sendStartGame(host: HDAccount, roomId: bigint, gasPriceGwei: number): Promise<Hex>;
  sendCommitDeck(
    agent: HDAccount,
    roomId: bigint,
    deckHash: Hex,
    gasPriceGwei: number
  ): Promise<Hex>;
  sendRevealDeck(
    agent: HDAccount,
    roomId: bigint,
    deck: string[],
    salt: string,
    gasPriceGwei: number
  ): Promise<Hex>;
  sendShareKeys(
    agent: HDAccount,
    roomId: bigint,
    recipients: Address[],
    encryptedKeys: Hex[],
    gasPriceGwei: number
  ): Promise<Hex>;
  sendCommitAndConfirmRole(
    agent: HDAccount,
    roomId: bigint,
    roleHash: Hex,
    gasPriceGwei: number
  ): Promise<Hex>;
}

// ─── Events / deps / outcomes ────────────────────────────────────────────────

export interface PreGameEvent {
  chainId: number;
  roomId: string;
}

export interface PreGameHandlerDeps {
  redis: Redis;
  chainOpsFor(chainId: number): PreGameChainOps;
  mnemonic: string;
  maxAgentsPerRoom?: number;
  txGasPriceGwei?: number;
  /**
   * Whether to call shareKeysToAll on-chain during REVEAL. Default false — it
   * never gates the DAY transition and the all-agent server resolves roles
   * directly, so it's pure gas. Enable for mixed games / on-chain completeness.
   */
  shareKeysOnChain?: boolean;
  /** GM in-memory store. Required for mixed (human+agent) role resolution; without
   *  it the mixed REVEAL branch degrades to resolve-failed. */
  store?: GMStore;
}

export type ShuffleStatus =
  | "shuffled"
  | "recovered"
  | "failed";

export interface ShuffleOutcome {
  agent: Address;
  status: ShuffleStatus;
  deckHash?: Hex;
  commitTxHash?: Hex;
  revealTxHash?: Hex;
  err?: string;
}

export type RevealStatus =
  | "confirmed"
  | "key-injected"
  | "skipped-already-confirmed"
  | "resolve-failed"
  | "failed";

export interface RevealOutcome {
  agent: Address;
  status: RevealStatus;
  roleId?: number;
  roleHash?: Hex;
  confirmTxHash?: Hex;
  shareKeysTxHash?: Hex;
  err?: string;
}

const MAX_SHUFFLE_ITERATIONS_SLACK = 3;

export class PreGameHandler {
  private readonly maxAgents: number;
  private readonly gas: number;
  private readonly shareKeysOnChain: boolean;

  constructor(private readonly deps: PreGameHandlerDeps) {
    this.maxAgents = deps.maxAgentsPerRoom ?? 8;
    this.gas = deps.txGasPriceGwei ?? 10;
    this.shareKeysOnChain = deps.shareKeysOnChain ?? false;
  }

  // ── SHUFFLING ──────────────────────────────────────────────────────────────

  async handleShuffling(event: PreGameEvent): Promise<ShuffleOutcome[]> {
    const chain = this.deps.chainOpsFor(event.chainId);
    const roomId = BigInt(event.roomId);
    const log = logger.child({
      mod: "agents/pregame",
      chainId: event.chainId,
      roomId: event.roomId,
      phase: "SHUFFLING",
    });

    const room0 = await chain.getRoom(roomId).catch((err) => {
      log.error({ err }, "[pregame] getRoom failed");
      return null;
    });
    if (!room0 || room0.phase !== GamePhase.SHUFFLING) return [];

    const players = await chain.getPlayers(roomId);
    const myByAddr = await this.resolveMyAgents(chain, roomId, players);
    if (myByAddr.size === 0) {
      log.info("[pregame] no agents of ours in room — nothing to shuffle");
      return [];
    }

    const outcomes: ShuffleOutcome[] = [];
    const maxIter = players.length + MAX_SHUFFLE_ITERATIONS_SLACK;
    for (let iter = 0; iter < maxIter; iter++) {
      const room = await chain.getRoom(roomId);
      if (room.phase !== GamePhase.SHUFFLING) break;
      const idx = room.currentShufflerIndex;
      if (idx >= players.length) break;

      const shufflerAddr = players[idx].wallet;
      const wallet = myByAddr.get(shufflerAddr.toLowerCase());
      if (!wallet) {
        // Current shuffler is a human / not ours — sequential phase can't skip.
        log.info(
          { idx, shuffler: shufflerAddr },
          "[pregame] current shuffler is not our agent — stopping (mixed game)"
        );
        break;
      }

      const fresh = await chain.getPlayers(roomId);
      const committed = (fresh[idx].flags & FLAGS.DECK_COMMITTED) !== 0;
      const outcome = await this.doShuffleTurn({
        chain,
        roomId,
        wallet,
        idx,
        committed,
        room,
        players,
        log,
      });
      outcomes.push(outcome);
      if (outcome.status === "failed") break; // don't spin on a stuck turn
    }
    return outcomes;
  }

  private async doShuffleTurn(args: {
    chain: PreGameChainOps;
    roomId: bigint;
    wallet: AgentWallet;
    idx: number;
    committed: boolean;
    room: RoomPregameSnapshot;
    players: readonly PlayerPregameSnapshot[];
    log: typeof logger;
  }): Promise<ShuffleOutcome> {
    const { chain, roomId, wallet, idx, committed, room, players, log } = args;
    const roomIdStr = roomId.toString();
    try {
      // Recovery: committed on chain but not yet revealed (crash between the two).
      if (committed) {
        const stored = await this.loadDeckCommit(chain.chainId, roomIdStr, wallet.address);
        if (!stored) {
          log.error(
            { agent: wallet.address, idx },
            "[pregame] agent DECK_COMMITTED but no stored deck — unrecoverable"
          );
          return { agent: wallet.address, status: "failed", err: "no-stored-deck" };
        }
        const revealTxHash = await chain.sendRevealDeck(
          wallet.account,
          roomId,
          stored.deck,
          stored.salt,
          this.gas
        );
        await this.clearDeckCommit(chain.chainId, roomIdStr, wallet.address);
        return { agent: wallet.address, status: "recovered", revealTxHash };
      }

      // Fresh turn: build → persist deck+salt → commit → reveal.
      const keys = await this.loadOrCreateSraKeys(chain.chainId, roomIdStr, wallet.address, roomId);
      const base =
        room.revealedCount === 0
          ? generateDistributedDeck(
              players.map((p) => ({ isAlive: (p.flags & FLAGS.ACTIVE) !== 0 })),
              roomId
            )
          : await chain.getDeck(roomId);
      const enc = encryptDeck(base, keys.e);
      const salt = generateSalt();
      await this.saveDeckCommit(chain.chainId, roomIdStr, wallet.address, enc, salt);

      const deckHash = deckCommitHash(enc, salt);
      const commitTxHash = await chain.sendCommitDeck(wallet.account, roomId, deckHash, this.gas);
      const revealTxHash = await chain.sendRevealDeck(wallet.account, roomId, enc, salt, this.gas);
      await this.clearDeckCommit(chain.chainId, roomIdStr, wallet.address);

      return { agent: wallet.address, status: "shuffled", deckHash, commitTxHash, revealTxHash };
    } catch (err: any) {
      log.error(
        { err: String(err?.message ?? err), agent: wallet.address, idx },
        "[pregame] shuffle turn failed"
      );
      return { agent: wallet.address, status: "failed", err: String(err?.message ?? err) };
    }
  }

  // ── REVEAL ───────────────────────────────────────────────────────────────

  async handleReveal(event: PreGameEvent): Promise<RevealOutcome[]> {
    const chain = this.deps.chainOpsFor(event.chainId);
    const roomId = BigInt(event.roomId);
    const roomIdStr = event.roomId;
    const log = logger.child({
      mod: "agents/pregame",
      chainId: event.chainId,
      roomId: event.roomId,
      phase: "REVEAL",
    });

    const room = await chain.getRoom(roomId).catch((err) => {
      log.error({ err }, "[pregame] getRoom failed");
      return null;
    });
    if (!room || room.phase !== GamePhase.REVEAL) return [];

    const players = await chain.getPlayers(roomId);
    const myByAddr = await this.resolveMyAgents(chain, roomId, players);
    if (myByAddr.size === 0) {
      log.info("[pregame] no agents of ours in room — nothing to reveal");
      return [];
    }
    const myAgents = [...myByAddr.values()];

    // Server-direct role resolution: we hold every agent's SRA key, so decrypt
    // the on-chain deck slot-by-slot. Needs ALL players' decryption keys.
    const dKeys: string[] = [];
    const missing: string[] = [];
    for (const p of players) {
      const k = await this.loadSraKeys(chain.chainId, roomIdStr, p.wallet);
      if (k) dKeys.push(k.d.toString());
      else missing.push(p.wallet);
    }
    if (missing.length > 0) {
      // MIXED game (humans present): we don't hold every key. Inject our agents'
      // keys into the shared GM resolution; the human submits theirs via HTTP.
      // When all are present, roleResolution fires onResolved -> confirmResolvedRoles.
      if (!this.deps.store) {
        log.error({ missing }, "[pregame] mixed game but no GMStore configured — cannot resolve");
        return myAgents.map((w) => ({ agent: w.address, status: "resolve-failed" as const }));
      }
      const store = this.deps.store;
      const outcomes: RevealOutcome[] = [];
      for (const w of myAgents) {
        const k = await this.loadSraKeys(chain.chainId, roomIdStr, w.address);
        if (!k) {
          outcomes.push({ agent: w.address, status: "resolve-failed" });
          continue;
        }
        try {
          await submitSraKey(
            {
              store,
              redis: this.deps.redis as any,
              chainId: chain.chainId,
              roomId: roomIdStr,
              fetchPlayers: async () => (await chain.getPlayers(roomId)).map((p) => ({ wallet: p.wallet })),
              fetchDeck: async () => chain.getDeck(roomId),
            },
            w.address,
            k.d.toString()
          );
          outcomes.push({ agent: w.address, status: "key-injected" });
        } catch (err: any) {
          log.error({ err: String(err?.message ?? err), agent: w.address }, "[pregame] submitSraKey failed");
          outcomes.push({ agent: w.address, status: "failed", err: String(err?.message ?? err) });
        }
      }
      log.info({ outcomes: outcomes.map((o) => o.status) }, "[pregame] mixed: agent keys injected; confirm via onResolved");
      return outcomes;
    }

    const deck = await chain.getDeck(roomId);
    if (deck.length === 0) {
      log.error("[pregame] revealed deck empty — cannot resolve roles");
      return myAgents.map((w) => ({ agent: w.address, status: "resolve-failed" as const }));
    }

    const roles = resolveRolesFromDeck(
      deck,
      players.map((p) => p.wallet),
      dKeys,
      roomId
    );
    await syncAgentRolesFromResolvedRoles(this.deps.redis, chain.chainId, roomIdStr, roles);

    // shareKeysToAll first (if enabled) — must complete before any confirm flips
    // the room to DAY (after which shareKeysToAll reverts WrongPhase).
    const shareTx = new Map<string, Hex>();
    if (this.shareKeysOnChain) {
      const pubByAddr = new Map(players.map((p) => [p.wallet.toLowerCase(), p.publicKey]));
      await Promise.all(
        myAgents.map(async (w) => {
          try {
            const k = await this.loadSraKeys(chain.chainId, roomIdStr, w.address);
            if (!k) return;
            const recipients = players
              .map((p) => p.wallet)
              .filter((a) => a.toLowerCase() !== w.address.toLowerCase());
            const encryptedKeys = recipients.map((r) =>
              this.encryptKeyFor(pubByAddr.get(r.toLowerCase()) ?? "0x", k.d.toString())
            );
            const tx = await chain.sendShareKeys(w.account, roomId, recipients, encryptedKeys, this.gas);
            shareTx.set(w.address.toLowerCase(), tx);
          } catch (err: any) {
            log.warn(
              { err: String(err?.message ?? err), agent: w.address },
              "[pregame] shareKeysToAll failed (non-gating) — continuing"
            );
          }
        })
      );
    }

    const flagsByAddr = new Map(players.map((p) => [p.wallet.toLowerCase(), p.flags]));
    const outcomes = await Promise.all(
      myAgents.map((w) =>
        this.doConfirmRole({
          chain,
          roomId,
          roomIdStr,
          wallet: w,
          role: roles.get(w.address.toLowerCase()) ?? Role.NONE,
          alreadyConfirmed:
            ((flagsByAddr.get(w.address.toLowerCase()) ?? 0) & FLAGS.CONFIRMED_ROLE) !== 0,
          shareKeysTxHash: shareTx.get(w.address.toLowerCase()),
          log,
        }).catch((err) => ({
          agent: w.address,
          status: "failed" as const,
          err: String(err?.message ?? err),
        }))
      )
    );
    return outcomes;
  }

  /**
   * Confirm role for each of our agents whose role is resolved in the GM store
   * and not yet confirmed on chain. Invoked by the roleResolution onResolved hook
   * (mixed games). Fire-and-forget; idempotent via FLAG_CONFIRMED_ROLE + revert.
   */
  async confirmResolvedRoles(chainId: number, roomId: string): Promise<RevealOutcome[]> {
    if (!this.deps.store) return [];
    const chain = this.deps.chainOpsFor(chainId);
    const roomIdBig = BigInt(roomId);
    const log = logger.child({ mod: "agents/pregame", chainId, roomId, phase: "REVEAL-confirm" });

    const room = await chain.getRoom(roomIdBig).catch(() => null);
    if (!room || room.phase !== GamePhase.REVEAL) return [];

    const players = await chain.getPlayers(roomIdBig);
    const myByAddr = await this.resolveMyAgents(chain, roomIdBig, players);
    if (myByAddr.size === 0) return [];

    const roomKey = this.deps.store.getRoomKey(chainId, roomId);
    const resolved = this.deps.store.resolvedRoles.get(roomKey);
    if (!resolved || resolved.size === 0) return [];

    const flagsByAddr = new Map(players.map((p) => [p.wallet.toLowerCase(), p.flags]));
    return Promise.all(
      [...myByAddr.values()].map((w) =>
        this.doConfirmRole({
          chain,
          roomId: roomIdBig,
          roomIdStr: roomId,
          wallet: w,
          role: (resolved.get(w.address.toLowerCase()) ?? Role.NONE) as Role,
          alreadyConfirmed: ((flagsByAddr.get(w.address.toLowerCase()) ?? 0) & FLAGS.CONFIRMED_ROLE) !== 0,
          log,
        }).catch((err) => ({
          agent: w.address,
          status: "failed" as const,
          err: String(err?.message ?? err),
        }))
      )
    );
  }

  private async doConfirmRole(args: {
    chain: PreGameChainOps;
    roomId: bigint;
    roomIdStr: string;
    wallet: AgentWallet;
    role: Role;
    alreadyConfirmed: boolean;
    shareKeysTxHash?: Hex;
    log: typeof logger;
  }): Promise<RevealOutcome> {
    const { chain, roomId, roomIdStr, wallet, role, alreadyConfirmed, shareKeysTxHash, log } = args;
    if (alreadyConfirmed) {
      return { agent: wallet.address, status: "skipped-already-confirmed", roleId: role || undefined };
    }
    if (role === Role.NONE) {
      log.error({ agent: wallet.address }, "[pregame] role resolved to NONE — not confirming");
      return { agent: wallet.address, status: "resolve-failed" };
    }
    try {
      const salt = await this.loadOrCreateRoleSalt(chain.chainId, roomIdStr, wallet.address);
      // ZK role commitment MUST be Poseidon(mafia?1:0, salt) — the SAME scheme
      // humans use (frontend createRoleCommitHashAsync + POST /submit-role-secret).
      // The old keccak roleCommitHash fails the endGameZK circuit ("Invalid ZK
      // State Hash"), so agent games could never finalize.
      const mappedRole = Number(role) === Role.MAFIA ? 1 : 0;
      const commitment = await calculatePoseidon([
        BigInt(mappedRole),
        BigInt("0x" + salt.replace(/^0x/, "")),
      ]);
      const roleHash = toHex(BigInt(commitment), { size: 32 });
      const confirmTxHash = await chain.sendCommitAndConfirmRole(
        wallet.account,
        roomId,
        roleHash,
        this.gas
      );
      // Persist the secret so the endgame ZK proof has the agent's real
      // commitment (humans do this via POST /submit-role-secret).
      await ServerStore.storeSecret(
        roomIdStr,
        wallet.address,
        Number(role),
        salt,
        commitment,
        chain.chainId
      ).catch((err: any) =>
        log.warn(
          { err: String(err?.message ?? err), agent: wallet.address },
          "[pregame] storeSecret failed — endgame proof may miss this agent"
        )
      );
      return {
        agent: wallet.address,
        status: "confirmed",
        roleId: role,
        roleHash,
        confirmTxHash,
        shareKeysTxHash,
      };
    } catch (err: any) {
      log.error(
        { err: String(err?.message ?? err), agent: wallet.address },
        "[pregame] commitAndConfirmRole failed"
      );
      return { agent: wallet.address, status: "failed", roleId: role, err: String(err?.message ?? err) };
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** isAgent-filter the room's players then HD-match to our mnemonic. */
  private async resolveMyAgents(
    chain: PreGameChainOps,
    roomId: bigint,
    players: readonly PlayerPregameSnapshot[]
  ): Promise<Map<string, AgentWallet>> {
    const isAgentFlags = await Promise.all(
      players.map((p) =>
        chain
          .isAgent(roomId, p.wallet)
          .then((flag) => ({ addr: p.wallet, flag }))
          .catch(() => ({ addr: p.wallet, flag: false }))
      )
    );
    const onChainAgents = isAgentFlags.filter((r) => r.flag).map((r) => r.addr);
    const matched = matchWalletsToAgents(this.deps.mnemonic, roomId, onChainAgents, this.maxAgents);
    return new Map(matched.map((w) => [w.address.toLowerCase(), w] as const));
  }

  private async loadSraKeys(
    chainId: number,
    roomId: string,
    agent: Address
  ): Promise<SraKeys | null> {
    const raw = await this.deps.redis.get(agentSraKey(chainId, roomId, agent));
    if (!raw) return null;
    try {
      const { e, d } = JSON.parse(raw);
      return { e: BigInt(e), d: BigInt(d) };
    } catch {
      return null;
    }
  }

  private async loadOrCreateSraKeys(
    chainId: number,
    roomId: string,
    agent: Address,
    roomIdBig: bigint
  ): Promise<SraKeys> {
    const existing = await this.loadSraKeys(chainId, roomId, agent);
    if (existing) return existing;
    const offset = getCardOffset(roomIdBig);
    const verifyValues = [1, 2, 3, 4].map((n) => String(n + offset));
    const keys = generateVerifiedSraKeys(verifyValues);
    await this.deps.redis.set(
      agentSraKey(chainId, roomId, agent),
      JSON.stringify({ e: keys.e.toString(), d: keys.d.toString() }),
      "EX",
      PREGAME_TTL_SECONDS
    );
    return keys;
  }

  private async loadOrCreateRoleSalt(
    chainId: number,
    roomId: string,
    agent: Address
  ): Promise<string> {
    const key = agentRoleSaltKey(chainId, roomId, agent);
    const existing = await this.deps.redis.get(key);
    if (existing) return existing;
    const salt = generateSalt();
    await this.deps.redis.set(key, salt, "EX", PREGAME_TTL_SECONDS);
    return salt;
  }

  private async saveDeckCommit(
    chainId: number,
    roomId: string,
    agent: Address,
    deck: string[],
    salt: string
  ): Promise<void> {
    await this.deps.redis.set(
      agentDeckCommitKey(chainId, roomId, agent),
      JSON.stringify({ deck, salt }),
      "EX",
      PREGAME_TTL_SECONDS
    );
  }

  private async loadDeckCommit(
    chainId: number,
    roomId: string,
    agent: Address
  ): Promise<{ deck: string[]; salt: string } | null> {
    const raw = await this.deps.redis.get(agentDeckCommitKey(chainId, roomId, agent));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async clearDeckCommit(chainId: number, roomId: string, agent: Address): Promise<void> {
    await this.deps.redis.del(agentDeckCommitKey(chainId, roomId, agent));
  }

  /** ECIES-encrypt our SRA decryption key to a recipient's pubkey → opaque bytes. */
  private encryptKeyFor(recipientPubkey: string, decryptionKey: string): Hex {
    const pk = recipientPubkey.startsWith("0x") ? recipientPubkey.slice(2) : recipientPubkey;
    const blob = eciesEncrypt(pk, decryptionKey);
    return toHex(JSON.stringify(blob));
  }
}

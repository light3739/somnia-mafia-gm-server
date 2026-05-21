/**
 * agents/phase-timeout.ts — agent-driven phase advancement.
 *
 * Time-based phase transitions (DAY→VOTING, VOTING→NIGHT) are normally driven by
 * an ALIVE player's browser calling forcePhaseTimeout at the deadline (see
 * SomniaMafia DayPhase.tsx — gated on `isAlive`, so DEAD players never kick).
 * When the last human dies (or in an all-agent game) only agents remain, none of
 * whom have a browser → the game stalls. Agents are real on-chain players
 * (isPlayerInRoom), so they may call forcePhaseTimeout exactly like a human.
 *
 * This module decides WHEN an agent should step in and WHICH agent sends it.
 * The buffer is deliberately larger than the browser's stagger (≈5s + 5s/idx) so
 * an alive human kicks first; agents only act when no one advanced the phase.
 *
 * NIGHT→DAY is NOT here — the GM already resolves night (doResolveNight).
 */
import type { Address, HDAccount, Hex } from "viem";
import { logger } from "../utils/logger.js";
import { matchWalletsToAgents } from "./wallets.js";

const FLAG_ACTIVE = 0x2;

export const PHASE_DAY = 3;
export const PHASE_VOTING = 4;

const KICKABLE_PHASES = new Set<number>([PHASE_DAY, PHASE_VOTING]);

export type KickReason =
  | "kick"
  | "phase-not-kickable"
  | "within-buffer"
  | "no-alive-agent";

export interface KickDecision {
  kick: boolean;
  /** The elected alive agent to send forcePhaseTimeout (lowest address), or null. */
  kicker: Address | null;
  reason: KickReason;
}

export interface DecideKickArgs {
  phase: number;
  phaseDeadlineSec: number;
  nowSec: number;
  /** Alive agents WE control in this room. */
  aliveAgents: readonly Address[];
  /** Seconds past the deadline before an agent steps in. Default 12 (> browser stagger). */
  bufferSec?: number;
}

export function decideKick(args: DecideKickArgs): KickDecision {
  const buffer = args.bufferSec ?? 12;

  if (!KICKABLE_PHASES.has(args.phase)) {
    return { kick: false, kicker: null, reason: "phase-not-kickable" };
  }
  if (args.nowSec <= args.phaseDeadlineSec + buffer) {
    return { kick: false, kicker: null, reason: "within-buffer" };
  }
  if (args.aliveAgents.length === 0) {
    return { kick: false, kicker: null, reason: "no-alive-agent" };
  }

  // Deterministic election: lowest address. Idempotent if several agents race —
  // the contract advances once; the rest revert harmlessly.
  const kicker = [...args.aliveAgents].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : 1
  )[0];
  return { kick: true, kicker, reason: "kick" };
}

// ─── Driver ────────────────────────────────────────────────────────────────

export interface PhaseTimeoutChainOps {
  readonly chainId: number;
  getRoom(roomId: bigint): Promise<{
    phase: number;
    phaseDeadline?: number;
    aliveCount: number;
  }>;
  getPlayers(
    roomId: bigint
  ): Promise<readonly { wallet: Address; flags: number }[]>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  sendForcePhaseTimeout(
    agent: HDAccount,
    roomId: bigint,
    gasPriceGwei: number
  ): Promise<Hex>;
}

export interface PhaseTimeoutDeps {
  chainOpsFor(chainId: number): PhaseTimeoutChainOps;
  mnemonic: string;
  maxAgentsPerRoom?: number;
  gasPriceGwei?: number;
  bufferSec?: number;
  /** Poll interval for the per-room watcher. Default 10s. */
  pollMs?: number;
  /** Injectable clock for tests. */
  nowSec?: () => number;
}

export interface TickResult {
  kicked: boolean;
  reason: KickReason | "not-in-room" | "send-failed";
  kicker?: Address;
  txHash?: Hex;
}

/**
 * Watches DAY/VOTING rooms and lets an alive agent call forcePhaseTimeout once
 * the deadline (+buffer) passes — covering the case where no alive human is left
 * to advance the phase from a browser.
 */
export class PhaseTimeoutDriver {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly maxAgents: number;
  private readonly gasPriceGwei: number;
  private readonly bufferSec: number;
  private readonly pollMs: number;
  private readonly nowSec: () => number;

  constructor(private readonly deps: PhaseTimeoutDeps) {
    this.maxAgents = deps.maxAgentsPerRoom ?? 6;
    this.gasPriceGwei = deps.gasPriceGwei ?? 10;
    this.bufferSec = deps.bufferSec ?? 12;
    this.pollMs = deps.pollMs ?? 10_000;
    this.nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  async tickOnce(chainId: number, roomId: bigint): Promise<TickResult> {
    const chain = this.deps.chainOpsFor(chainId);
    const room = await chain.getRoom(roomId).catch(() => null);
    if (!room) return { kicked: false, reason: "not-in-room" };

    const players = await chain.getPlayers(roomId).catch(() => []);
    const aliveAddrs = players
      .filter((p) => (p.flags & FLAG_ACTIVE) !== 0)
      .map((p) => p.wallet);

    const flags = await Promise.all(
      aliveAddrs.map((a) =>
        chain
          .isAgent(roomId, a)
          .then((f) => ({ a, f }))
          .catch(() => ({ a, f: false }))
      )
    );
    const aliveOnChainAgents = flags.filter((r) => r.f).map((r) => r.a);
    const myAgents = matchWalletsToAgents(
      this.deps.mnemonic,
      roomId,
      aliveOnChainAgents,
      this.maxAgents
    );

    const decision = decideKick({
      phase: room.phase,
      phaseDeadlineSec: room.phaseDeadline ?? 0,
      nowSec: this.nowSec(),
      aliveAgents: myAgents.map((w) => w.address),
      bufferSec: this.bufferSec,
    });
    if (!decision.kick || !decision.kicker) {
      return { kicked: false, reason: decision.reason };
    }

    const wallet = myAgents.find(
      (w) => w.address.toLowerCase() === decision.kicker!.toLowerCase()
    );
    if (!wallet) return { kicked: false, reason: "no-alive-agent" };

    try {
      const txHash = await chain.sendForcePhaseTimeout(
        wallet.account,
        roomId,
        this.gasPriceGwei
      );
      logger.info(
        { chainId, roomId: String(roomId), kicker: wallet.address, txHash, phase: room.phase },
        "[agents/phase-timeout] agent advanced phase"
      );
      return { kicked: true, reason: "kick", kicker: wallet.address, txHash };
    } catch (err: any) {
      // Revert is EXPECTED when someone else already advanced (WrongPhase) or the
      // clock was a touch early (TooEarly). Not an error — next tick re-checks.
      logger.debug(
        { chainId, roomId: String(roomId), err: String(err?.message ?? err) },
        "[agents/phase-timeout] forcePhaseTimeout reverted (likely already advanced)"
      );
      return { kicked: false, reason: "send-failed", kicker: wallet.address };
    }
  }

  /** Start (or restart) the per-room watcher. Call on DAY_STARTED / VOTING_STARTED. */
  start(chainId: number, roomId: bigint): void {
    const key = `${chainId}:${roomId}`;
    this.stop(key);
    const t = setInterval(() => {
      this.tickOnce(chainId, roomId).catch((err) =>
        logger.error({ err, key }, "[agents/phase-timeout] tick threw")
      );
    }, this.pollMs);
    (t as any).unref?.();
    this.timers.set(key, t);
  }

  /** Stop the watcher for a room. Call on NIGHT_STARTED / GAME_ENDED. */
  stop(key: string): void {
    const t = this.timers.get(key);
    if (t) {
      clearInterval(t);
      this.timers.delete(key);
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}

/**
 * agents/headless-day.ts — agent-driven DAY discussion start (headless games).
 *
 * The DAY discussion (and agent chat) is normally orchestrated by an ALIVE
 * human's browser: it POSTs /discussion `start` and polls GET /discussion to
 * advance the speaker rotation; each agent's turn then runs via turnController
 * (→ DayHandler.speakAgentTurn). The DAY_STARTED on-chain event does NOT drive
 * the chat — only the phase-timeout watch.
 *
 * So when the last human dies (or an all-agent game), nobody starts/advances the
 * rotation: agents never speak, the discussion state never goes active, and the
 * room sits on "Waiting for discussion to start..." (no chat, no timer, empty
 * /logs) until the phase-timeout driver kicks at the deadline.
 *
 * This driver makes an agent do exactly what a player's browser would, but only
 * when there is no alive human to do it:
 *   1. start the discussion server-side (state → speaking),
 *   2. drive the agent turns to completion (turnController rolls through the
 *      all-agent rotation), then
 *   3. have an alive agent call startVoting() so the day doesn't sit silent
 *      until the deadline (no dead tail).
 *
 * Mixed games (any alive human) are left entirely to the proven browser path.
 */
import type { Address, HDAccount, Hex } from "viem";
import { logger } from "../utils/logger.js";
import { matchWalletsToAgents } from "./wallets.js";

const FLAG_ACTIVE = 0x2;
const PHASE_DAY = 3;

export interface HeadlessDayChainOps {
  readonly chainId: number;
  getRoom(roomId: bigint): Promise<{
    phase: number;
    dayCount: number;
    aliveCount: number;
  }>;
  getPlayers(
    roomId: bigint
  ): Promise<readonly { wallet: Address; flags: number }[]>;
  isAgent(roomId: bigint, addr: Address): Promise<boolean>;
  /** An alive agent calls startVoting(roomId) to advance DAY→VOTING early. */
  sendStartVoting(
    agent: HDAccount,
    roomId: bigint,
    gasPriceGwei: number
  ): Promise<Hex>;
}

export interface HeadlessDayDeps {
  chainOpsFor(chainId: number): HeadlessDayChainOps;
  mnemonic: string;
  /** Set the discussion state to "speaking" (idx 0) + broadcast — the server-side
   *  equivalent of a player's browser POSTing /discussion `start`. */
  startDiscussion(
    chainId: number,
    roomId: string,
    dayCount: number
  ): Promise<void>;
  /** Drive the agent turn rotation to completion (turnController.onSpeakerChanged). */
  driveTurns(chainId: number, roomId: string, dayCount: number): Promise<void>;
  /** Once-per-(chain,room,day) claim. Returns true iff THIS call won the claim. */
  claimOnce(chainId: number, roomId: string, dayCount: number): Promise<boolean>;
  maxAgentsPerRoom?: number;
  gasPriceGwei?: number;
  /** Whether DAY chat is enabled (turnController configured). When false the
   *  driver is a no-op — driving turns without a configured controller is
   *  pointless and we must not advance the phase with no discussion. */
  dayEnabled: boolean;
}

export type HeadlessOutcomeReason =
  | "driven"
  | "phase-advanced"
  | "day-disabled"
  | "not-day"
  | "humans-present"
  | "no-agents"
  | "already-claimed";

export interface HeadlessDayOutcome {
  driven: boolean;
  reason: HeadlessOutcomeReason;
  votingTx?: Hex;
}

export class HeadlessDayDriver {
  private readonly maxAgents: number;
  private readonly gasPriceGwei: number;

  constructor(private readonly deps: HeadlessDayDeps) {
    this.maxAgents = deps.maxAgentsPerRoom ?? 6;
    this.gasPriceGwei = deps.gasPriceGwei ?? 10;
  }

  async onDayStarted(args: {
    chainId: number;
    roomId: string;
  }): Promise<HeadlessDayOutcome> {
    const { chainId, roomId } = args;
    const log = logger.child({ mod: "agents/headless-day", chainId, roomId });

    if (!this.deps.dayEnabled) {
      return { driven: false, reason: "day-disabled" };
    }

    const chain = this.deps.chainOpsFor(chainId);
    const roomIdBig = BigInt(roomId);

    const room = await chain.getRoom(roomIdBig).catch(() => null);
    if (!room || room.phase !== PHASE_DAY) {
      return { driven: false, reason: "not-day" };
    }
    const dayCount = room.dayCount;

    const players = await chain.getPlayers(roomIdBig).catch(() => []);
    const aliveAddrs = players
      .filter((p) => (p.flags & FLAG_ACTIVE) !== 0)
      .map((p) => p.wallet);

    // Detect headless: any ALIVE non-agent (a human) means the browser path
    // owns the discussion — leave it alone.
    const agentFlags = await Promise.all(
      aliveAddrs.map((a) =>
        chain
          .isAgent(roomIdBig, a)
          .then((f) => ({ a, f }))
          .catch(() => ({ a, f: false }))
      )
    );
    const aliveHumans = agentFlags.filter((r) => !r.f);
    if (aliveHumans.length > 0) {
      return { driven: false, reason: "humans-present" };
    }

    const aliveOnChainAgents = agentFlags.filter((r) => r.f).map((r) => r.a);
    const myAgents = matchWalletsToAgents(
      this.deps.mnemonic,
      roomIdBig,
      aliveOnChainAgents,
      this.maxAgents
    );
    if (myAgents.length === 0) {
      return { driven: false, reason: "no-agents" };
    }

    // Claim AFTER confirming headless+ours, so mixed/foreign games never burn
    // the once-per-day claim (and re-delivery of DAY_STARTED is a no-op).
    const won = await this.deps
      .claimOnce(chainId, roomId, dayCount)
      .catch(() => false);
    if (!won) {
      return { driven: false, reason: "already-claimed" };
    }

    log.info(
      { dayCount, agents: myAgents.length },
      "[agents/headless-day] no alive human — GM driving DAY discussion"
    );

    // 1. Start the discussion server-side (state → speaking) so the rotation has
    //    a current speaker for turnController to act on, and the (dead) spectator's
    //    GET /discussion poll flips from "Waiting..." to the live speaker view.
    await this.deps.startDiscussion(chainId, roomId, dayCount);

    // 2. Drive the agent turns to completion. With an all-agent rotation,
    //    turnController.onSpeakerChanged speaks each agent then advances, looping
    //    until the discussion is finished.
    await this.deps.driveTurns(chainId, roomId, dayCount);

    // 3. Start voting early (an alive agent calls startVoting) so the day doesn't
    //    sit silent until the deadline. Skip if the phase already advanced (a
    //    browser-less race, or the phase-timeout driver beat us).
    const recheck = await chain.getRoom(roomIdBig).catch(() => null);
    if (!recheck || recheck.phase !== PHASE_DAY) {
      return { driven: true, reason: "phase-advanced" };
    }

    const kicker = [...myAgents].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
    )[0];
    try {
      const votingTx = await chain.sendStartVoting(
        kicker.account,
        roomIdBig,
        this.gasPriceGwei
      );
      log.info(
        { dayCount, kicker: kicker.address, votingTx },
        "[agents/headless-day] discussion done — agent started voting"
      );
      return { driven: true, reason: "driven", votingTx };
    } catch (err: any) {
      // WrongPhase (someone already advanced) or a transient revert — the chat
      // already happened, and the phase-timeout driver still covers the deadline.
      log.debug(
        { err: String(err?.message ?? err) },
        "[agents/headless-day] startVoting reverted (likely already advanced)"
      );
      return { driven: true, reason: "driven" };
    }
  }
}

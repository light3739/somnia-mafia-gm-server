/**
 * agents/agent-funding.ts — mid-game sponsor auto-topup for agent EOAs.
 *
 * fill-room funds each agent ONCE at join with a fixed gas reserve. Over a long
 * game an agent can still deplete below one inference deposit (~0.24 STT/call),
 * after which AgentRequester.createRequest reverts and the agent goes silent.
 * Phase handlers call ensureAgentFunded before spending so a depleted wallet is
 * topped up from the sponsor first — never draining the sponsor below its floor
 * (which the DAY sponsor guard also relies on).
 *
 * Pure decision logic + delegation: balance reads and the value transfer are
 * injected via FundingOps so this is unit-testable without chain wiring.
 */
import type { Address, Hex } from "viem";

export interface FundingOps {
  /** Native balance of an arbitrary address (the agent EOA). */
  getBalanceWei(addr: Address): Promise<bigint>;
  /** Native balance of the sponsor wallet. */
  getSponsorBalanceWei(): Promise<bigint>;
  /** Send `valueWei` from the sponsor to `to`; resolves once landed. */
  topUp(to: Address, valueWei: bigint): Promise<Hex>;
}

export interface EnsureFundedOpts {
  /** Top up only when the agent balance is below this. */
  minWei: bigint;
  /** Target agent balance after a top-up. */
  topUpToWei: bigint;
  /** Never let the top-up drop the sponsor below this reserve. */
  sponsorFloorWei: bigint;
}

export interface EnsureFundedResult {
  /** Agent ends with >= minWei (either already had it, or was topped up). */
  funded: boolean;
  toppedUp: boolean;
  /** Best-known agent balance after the call. */
  balanceWei: bigint;
  txHash?: Hex;
  reason: "already-funded" | "topped-up" | "sponsor-floor";
}

export async function ensureAgentFunded(
  ops: FundingOps,
  agent: Address,
  opts: EnsureFundedOpts
): Promise<EnsureFundedResult> {
  const balance = await ops.getBalanceWei(agent);
  if (balance >= opts.minWei) {
    return { funded: true, toppedUp: false, balanceWei: balance, reason: "already-funded" };
  }

  const need = opts.topUpToWei - balance;
  const sponsor = await ops.getSponsorBalanceWei();
  if (sponsor - need < opts.sponsorFloorWei) {
    return { funded: false, toppedUp: false, balanceWei: balance, reason: "sponsor-floor" };
  }

  const txHash = await ops.topUp(agent, need);
  return { funded: true, toppedUp: true, balanceWei: opts.topUpToWei, txHash, reason: "topped-up" };
}

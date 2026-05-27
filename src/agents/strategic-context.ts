import type { Redis } from "ioredis";
import { getAddress, type Address } from "viem";
import { agentChatPromptKey, agentTraceKey } from "./redis-keys.js";
import { AgentRole } from "./roles.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

type NameOf = (addr: string) => string;

type GameLogLike = {
  eventType?: string;
  eventData?: Record<string, unknown>;
  message?: string;
};

type VoteEntry = { from: Address; to: Address };
type VoteRound = {
  day: number;
  votes: VoteEntry[];
  eliminated?: Address | null;
};
type NightRound = {
  day: number;
  killed?: Address | null;
  safe?: boolean;
};

export type PublicGameContext = {
  lines: string[];
  consensusTarget: Address | null;
  stalledVoteRounds: number;
};

function roomLogsKey(chainId: number, roomId: string): string {
  return `room:logs:${chainId}:${roomId}`;
}

function shortAddr(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function asAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  const match = value.match(/0x[a-fA-F0-9]{40}/);
  if (!match) return null;
  try {
    return getAddress(match[0]);
  } catch {
    return null;
  }
}

function display(addr: Address, nameOf?: NameOf): string {
  const name = nameOf?.(addr)?.trim();
  if (!name || name.toLowerCase().startsWith("0x")) return shortAddr(addr);
  return `${name} ${shortAddr(addr)}`;
}

export function majorityNeeded(aliveCount: number): number {
  return Math.floor(aliveCount / 2) + 1;
}

function parseLogs(raw: string | null): GameLogLike[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GameLogLike[]) : [];
  } catch {
    return [];
  }
}

function getOrCreateVoteRound(rounds: Map<number, VoteRound>, day: number): VoteRound {
  const existing = rounds.get(day);
  if (existing) return existing;
  const next = { day, votes: [] };
  rounds.set(day, next);
  return next;
}

function parseVoteRounds(logs: readonly GameLogLike[]): VoteRound[] {
  const rounds = new Map<number, VoteRound>();
  let currentDay = 0;

  for (const log of logs) {
    if (log.eventType === "DayStarted") {
      const day = Number(log.eventData?.dayNumber ?? currentDay);
      if (Number.isFinite(day) && day > 0) currentDay = day;
      continue;
    }

    if (log.eventType === "PLAYER_VOTED") {
      if (currentDay <= 0) continue;
      const from = asAddress(log.eventData?.voterAddress);
      const to = asAddress(log.eventData?.targetAddress);
      if (!from || !to) continue;
      getOrCreateVoteRound(rounds, currentDay).votes.push({ from, to });
      continue;
    }

    if (log.eventType === "VOTING_RESULT") {
      if (currentDay <= 0) continue;
      const round = getOrCreateVoteRound(rounds, currentDay);
      round.eliminated = asAddress(log.eventData?.playerAddress);
    }
  }

  return [...rounds.values()].sort((a, b) => a.day - b.day);
}

function parseNightRounds(logs: readonly GameLogLike[]): NightRound[] {
  const rounds = new Map<number, NightRound>();
  let currentDay = 0;

  for (const log of logs) {
    if (log.eventType === "DayStarted") {
      const day = Number(log.eventData?.dayNumber ?? currentDay);
      if (Number.isFinite(day) && day > 0) currentDay = day;
      continue;
    }
    if (log.eventType !== "NIGHT_RESULT" || currentDay <= 0) continue;

    const killed = asAddress(log.eventData?.playerAddress);
    rounds.set(currentDay, {
      day: currentDay,
      killed,
      safe: !killed || Boolean(log.eventData?.isSafe),
    });
  }

  return [...rounds.values()].sort((a, b) => a.day - b.day);
}

function tallyVotes(votes: readonly VoteEntry[]): { target: Address; count: number }[] {
  const counts = new Map<string, { target: Address; count: number }>();
  for (const vote of votes) {
    const key = vote.to.toLowerCase();
    const prev = counts.get(key);
    if (prev) prev.count += 1;
    else counts.set(key, { target: vote.to, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function summarizeVoteRound(round: VoteRound, nameOf?: NameOf): string {
  const tallies = tallyVotes(round.votes)
    .slice(0, 3)
    .map((t) => `${display(t.target, nameOf)}=${t.count}`)
    .join(", ");
  const result = round.eliminated
    ? `eliminated ${display(round.eliminated, nameOf)}`
    : "no elimination";
  return `Day ${round.day}: ${tallies || "no votes"}; ${result}.`;
}

function summarizeNightRound(round: NightRound, nameOf?: NameOf): string {
  if (round.killed && round.killed !== ZERO_ADDR) {
    return `Night ${round.day}: ${display(round.killed, nameOf)} died.`;
  }
  return `Night ${round.day}: no one died.`;
}

function latestBefore<T extends { day: number }>(
  rounds: readonly T[],
  currentDay: number
): T | null {
  for (const round of [...rounds].reverse()) {
    if (round.day < currentDay) return round;
  }
  return null;
}

function summarizeLatestVoteRecap(round: VoteRound, nameOf?: NameOf): string {
  const top = tallyVotes(round.votes)
    .slice(0, 3)
    .map((t) => `${display(t.target, nameOf)}=${t.count}`)
    .join(", ");
  if (round.eliminated) {
    return `Previous vote: Day ${round.day}, ${display(round.eliminated, nameOf)} was voted out. Vote pressure: ${top || "no recorded votes"}.`;
  }
  return `Previous vote: Day ${round.day}, no one was voted out. Vote pressure: ${top || "no recorded votes"}.`;
}

function summarizeLatestNightRecap(round: NightRound, nameOf?: NameOf): string {
  if (round.killed && round.killed !== ZERO_ADDR) {
    return `Last night: ${display(round.killed, nameOf)} was killed by Mafia.`;
  }
  return `Last night: no one died.`;
}

function countRecentStalls(rounds: readonly VoteRound[], currentDay: number): number {
  let count = 0;
  for (const round of [...rounds].reverse()) {
    if (round.day >= currentDay || round.votes.length === 0) continue;
    if (round.eliminated) break;
    count += 1;
  }
  return count;
}

function chooseConsensusTarget(
  rounds: readonly VoteRound[],
  currentDay: number,
  alive: readonly Address[],
  self?: Address
): Address | null {
  const aliveSet = new Set(alive.map((a) => a.toLowerCase()));
  const selfLower = self?.toLowerCase();
  for (const round of [...rounds].reverse()) {
    if (round.day >= currentDay || round.votes.length === 0) continue;
    for (const tally of tallyVotes(round.votes)) {
      const lower = tally.target.toLowerCase();
      if (aliveSet.has(lower) && lower !== selfLower) return tally.target;
    }
  }
  return null;
}

export async function loadRecentPromptChat(
  redis: Pick<Redis, "lrange">,
  chainId: number,
  roomId: string,
  limit = 15
): Promise<{ from: Address; text: string }[]> {
  const raw = await redis.lrange(agentChatPromptKey(chainId, roomId), -limit, -1);
  const out: { from: Address; text: string }[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item);
      const from = asAddress(parsed?.by);
      if (!from || typeof parsed?.text !== "string" || !parsed.text.trim()) continue;
      out.push({ from, text: parsed.text.trim() });
    } catch {
      /* ignore malformed chat rows */
    }
  }
  return out;
}

export async function loadPublicGameContext(
  redis: Pick<Redis, "get">,
  args: {
    chainId: number;
    roomId: string;
    currentDay: number;
    alive: readonly Address[];
    self?: Address;
    nameOf?: NameOf;
    maxVoteDays?: number;
    maxNightDays?: number;
    includeCurrentDayVotes?: boolean;
  }
): Promise<PublicGameContext> {
  const logs = parseLogs(await redis.get(roomLogsKey(args.chainId, args.roomId)));
  const voteRounds = parseVoteRounds(logs);
  const nightRounds = parseNightRounds(logs);
  const required = majorityNeeded(args.alive.length);
  const stalled = countRecentStalls(voteRounds, args.currentDay);
  const consensusTarget = chooseConsensusTarget(
    voteRounds,
    args.currentDay,
    args.alive,
    args.self
  );
  const recentVotes = voteRounds
    .filter((r) =>
      args.includeCurrentDayVotes ? r.day <= args.currentDay : r.day < args.currentDay
    )
    .slice(-(args.maxVoteDays ?? 5));
  const recentNights = nightRounds
    .filter((r) => r.day < args.currentDay)
    .slice(-(args.maxNightDays ?? 3));
  const latestVote = latestBefore(voteRounds, args.currentDay);
  const latestNight = latestBefore(nightRounds, args.currentDay);

  const lines = [
    `Elimination threshold today: ${required}/${args.alive.length} alive votes.`,
  ];
  if (latestVote || latestNight) {
    lines.push("Latest public recap:");
    if (latestVote) lines.push(`- ${summarizeLatestVoteRecap(latestVote, args.nameOf)}`);
    if (latestNight) lines.push(`- ${summarizeLatestNightRecap(latestNight, args.nameOf)}`);
  }
  if (recentVotes.length > 0) {
    lines.push("Recent vote history:");
    for (const round of recentVotes) lines.push(`- ${summarizeVoteRound(round, args.nameOf)}`);
  }
  if (recentNights.length > 0) {
    lines.push("Recent night results:");
    for (const round of recentNights) lines.push(`- ${summarizeNightRound(round, args.nameOf)}`);
  }
  if (stalled >= 2) {
    lines.push(
      `Stall warning: ${stalled} recent voting rounds ended without elimination. Coordinate on one realistic target; split votes will extend the loop.`
    );
  }
  if (consensusTarget) {
    lines.push(
      `Consensus cue: the latest viable vote leader is ${display(consensusTarget, args.nameOf)}. Consolidate there unless you have stronger evidence.`
    );
  }

  return {
    lines,
    consensusTarget,
    stalledVoteRounds: stalled,
  };
}

export async function loadPublicGameContextLines(
  redis: Pick<Redis, "get">,
  args: Parameters<typeof loadPublicGameContext>[1]
): Promise<string[]> {
  return (await loadPublicGameContext(redis, args)).lines;
}

type TraceLike = {
  action?: string;
  target?: string;
};

function actionVerb(action: string): string {
  switch (action) {
    case "KILL":
      return "tried to kill";
    case "HEAL":
      return "protected";
    case "CHECK":
      return "investigated";
    default:
      return "targeted";
  }
}

function rolePatternWarning(role: AgentRole, action: string, target: Address, repeat: number, nameOf?: NameOf): string | null {
  if (repeat < 2) return null;
  const targetName = display(target, nameOf);
  if (role === AgentRole.MAFIA && action === "KILL") {
    return `Pattern warning: your last ${repeat} kill choices all targeted ${targetName}. If nobody died after those nights, assume protection and switch targets.`;
  }
  if (role === AgentRole.DOCTOR && action === "HEAL") {
    return `Pattern warning: your last ${repeat} protects all targeted ${targetName}. Do not autopilot; rotate unless today's public context makes that player the obvious kill target.`;
  }
  if (role === AgentRole.DETECTIVE && action === "CHECK") {
    return `Pattern warning: your last ${repeat} investigations repeated ${targetName}. Check someone new unless this is deliberate.`;
  }
  return null;
}

export async function loadPrivateNightMemoryLines(
  redis: Pick<Redis, "get">,
  args: {
    chainId: number;
    roomId: string;
    agent: Address;
    role: AgentRole;
    currentDay: number;
    nameOf?: NameOf;
    maxNights?: number;
  }
): Promise<string[]> {
  const maxNights = args.maxNights ?? 6;
  const start = Math.max(1, args.currentDay - maxNights);
  const traces: { day: number; action: string; target: Address }[] = [];

  for (let day = start; day < args.currentDay; day++) {
    const raw = await redis.get(
      agentTraceKey(args.chainId, args.roomId, `D${day}-NIGHT`, args.agent)
    );
    if (!raw) continue;
    let parsed: TraceLike;
    try {
      parsed = JSON.parse(raw) as TraceLike;
    } catch {
      continue;
    }
    if (!parsed.action || parsed.action === "SKIP") continue;
    const target = asAddress(parsed.target);
    if (!target || target === ZERO_ADDR) continue;
    traces.push({ day, action: parsed.action, target });
  }

  const lines = traces.map(
    (t) => `Night ${t.day}: you ${actionVerb(t.action)} ${display(t.target, args.nameOf)}.`
  );

  const last = traces[traces.length - 1];
  if (last) {
    let repeat = 0;
    for (let i = traces.length - 1; i >= 0; i--) {
      const t = traces[i];
      if (
        t.action === last.action &&
        t.target.toLowerCase() === last.target.toLowerCase()
      ) {
        repeat += 1;
      } else {
        break;
      }
    }
    const warning = rolePatternWarning(
      args.role,
      last.action,
      last.target,
      repeat,
      args.nameOf
    );
    if (warning) lines.push(warning);
  }

  return lines;
}

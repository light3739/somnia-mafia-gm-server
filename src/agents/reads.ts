/**
 * agents/reads.ts — pure, chain-derived "reads" lines for an agent's private
 * memory. Derived ONLY from on-chain vote rounds (no chat-text summarization),
 * so a player can't steer another agent's suspicion by typing.
 */
import type { Address } from "viem";

export type ReadsVote = { from: Address; to: Address };
export type ReadsRound = { day: number; votes: ReadsVote[] };
type NameOf = (addr: string) => string;

export function deriveReads(rounds: readonly ReadsRound[], self: Address, nameOf: NameOf): string[] {
  const me = self.toLowerCase();
  const lines: string[] = [];

  // 1. Voted against me.
  for (const r of rounds)
    for (const v of r.votes)
      if (v.to.toLowerCase() === me && v.from.toLowerCase() !== me)
        lines.push(`${nameOf(v.from)} voted against you on Day ${r.day}.`);

  // 2. Bandwagon pairs (same target same day, on >= 2 days).
  const pairDays = new Map<string, Set<number>>();
  for (const r of rounds) {
    const byTarget = new Map<string, string[]>();
    for (const v of r.votes) {
      const t = v.to.toLowerCase();
      const arr = byTarget.get(t) ?? [];
      arr.push(v.from.toLowerCase());
      byTarget.set(t, arr);
    }
    for (const voters of byTarget.values()) {
      const uniq = [...new Set(voters)].filter((a) => a !== me).sort();
      for (let i = 0; i < uniq.length; i++)
        for (let j = i + 1; j < uniq.length; j++) {
          const key = `${uniq[i]}|${uniq[j]}`;
          const set = pairDays.get(key) ?? new Set<number>();
          set.add(r.day);
          pairDays.set(key, set);
        }
    }
  }
  for (const [key, days] of pairDays)
    if (days.size >= 2) {
      const [a, b] = key.split("|");
      lines.push(`${nameOf(a)} and ${nameOf(b)} keep voting together.`);
    }

  // 3. Flips: a voter whose target changed between rounds.
  const lastTarget = new Map<string, string>();
  for (const r of rounds)
    for (const v of r.votes) {
      const f = v.from.toLowerCase();
      if (f === me) continue;
      const cur = v.to.toLowerCase();
      const prev = lastTarget.get(f);
      if (prev && prev !== cur)
        lines.push(`${nameOf(f)} switched from voting ${nameOf(prev)} to voting ${nameOf(cur)}.`);
      lastTarget.set(f, cur);
    }

  // 4. Own last stance (consistency).
  let myLast: string | null = null;
  for (const r of rounds) for (const v of r.votes) if (v.from.toLowerCase() === me) myLast = v.to.toLowerCase();
  if (myLast) lines.push(`You previously voted ${nameOf(myLast)}. Stay consistent unless new evidence changed your mind.`);

  return [...new Set(lines)].slice(0, 6);
}

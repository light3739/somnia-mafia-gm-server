/**
 * agents/game-math.ts — pure game-state math for agent prompts.
 * Role census (deterministic, public; mirrors crypto/sra.generateDistributedDeck)
 * + win-state math. No Redis, no chain. See 2026-05-29-agent-prompt-brain-design.md.
 */
export interface RoleCensus {
  total: number;
  mafia: number;
  doctor: number;
  detective: number;
  citizens: number;
}

/** Mirrors generateDistributedDeck / LibGame.expectedMafiaCount. */
export function roleCensus(startingActive: number): RoleCensus {
  const n = Math.max(0, Math.trunc(startingActive));
  const mafia = n < 1 ? 0 : n <= 5 ? 1 : n <= 8 ? 2 : n <= 11 ? 3 : 4;
  const doctor = n >= 4 ? 1 : 0;
  const detective = n >= 5 ? 1 : 0;
  const citizens = Math.max(0, n - mafia - doctor - detective);
  return { total: n, mafia, doctor, detective, citizens };
}

export interface WinMath {
  aliveCount: number;
  mafiaAlive: number;
  townAlive: number;
  /** Town deaths still needed for Mafia to reach parity (and win). */
  townDeathsToMafiaWin: number;
}

export function computeWinMath(args: { aliveCount: number; mafiaAlive: number }): WinMath {
  const aliveCount = Math.max(0, Math.trunc(args.aliveCount));
  const mafiaAlive = Math.max(0, Math.trunc(args.mafiaAlive));
  const townAlive = Math.max(0, aliveCount - mafiaAlive);
  return { aliveCount, mafiaAlive, townAlive, townDeathsToMafiaWin: Math.max(0, townAlive - mafiaAlive) };
}

export function censusLines(startingActive: number, aliveNow: number): string[] {
  const c = roleCensus(startingActive);
  const dead = Math.max(0, c.total - aliveNow);
  return [
    `Game setup: ${c.total} players — ${c.mafia} Mafia, ${c.doctor} Doctor, ${c.detective} Detective, ${c.citizens} Citizens. Roles are revealed only when the game ends.`,
    `Alive now: ${aliveNow} of ${c.total}. Eliminated so far: ${dead} (their roles stay hidden).`,
  ];
}

export function townWinLines(args: { aliveNow: number; startingMafia: number }): string[] {
  const aliveNow = Math.max(0, Math.trunc(args.aliveNow));
  const startingMafia = Math.max(0, Math.trunc(args.startingMafia));
  const worstMafia = Math.min(startingMafia, aliveNow);
  const slack = aliveNow - 2 * worstMafia;
  const lines = ["Town wins by voting out every Mafia. Town LOSES the instant living Town <= living Mafia."];
  if (slack > 0) {
    lines.push(`Worst case all ${startingMafia} Mafia are still alive — Town can afford to lose at most ${slack} more of its own before Mafia can reach parity. Make this vote count.`);
  } else {
    lines.push(`If every starting Mafia is still alive, Mafia may already be one good night from parity — do not waste this vote.`);
  }
  return lines;
}

export function mafiaWinLines(args: { mafiaAlive: number; townAlive: number; teammateNames: string[] }): string[] {
  const m = computeWinMath({ aliveCount: args.mafiaAlive + args.townAlive, mafiaAlive: args.mafiaAlive });
  const team = args.teammateNames.length > 0 ? `you + ${args.teammateNames.join(", ")}` : `you (no confirmed living teammates)`;
  return [
    `Your Mafia team: ${team}. Mafia alive: ${m.mafiaAlive}.`,
    `Exact count — Mafia alive: ${m.mafiaAlive}, Town alive: ${m.townAlive}. You win when Mafia >= Town. Town deaths still needed to win: ${m.townDeathsToMafiaWin}.`,
  ];
}

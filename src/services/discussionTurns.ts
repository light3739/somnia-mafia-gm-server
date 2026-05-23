/**
 * services/discussionTurns.ts — shared DAY discussion turn mechanics.
 * Extracted from discussionRoutes so the agent turn-controller and the route
 * use the SAME deterministic speaker order and advance/broadcast logic.
 */
import { getPlayers, FLAGS } from "../chain.js";
import { ServerStore } from "./serverStore.js";
import { wsManager } from "../ws/wsManager.js";

export function shufflePlayers(players: readonly any[], roomId: string): any[] {
  const shuffled = [...players];
  const seed = Number(BigInt(roomId) % 1000000n);
  let m = shuffled.length, t, i;
  let s = seed;

  const random = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  while (m) {
    i = Math.floor(random() * m--);
    t = shuffled[m];
    shuffled[m] = shuffled[i];
    shuffled[i] = t;
  }
  return shuffled;
}

export async function getAliveShuffled(chainId: number, roomId: string): Promise<any[]> {
  const players = await getPlayers(BigInt(roomId), chainId);
  return shufflePlayers(players, roomId).filter(
    (p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0
  );
}

/** Current speaker for the live discussion state, or null if none/finished. */
export async function getCurrentSpeaker(
  chainId: number,
  roomId: string,
  dayCount: number
): Promise<{ addr: string; index: number; finished: boolean } | null> {
  const state = await ServerStore.getDiscussionState(roomId, dayCount, chainId);
  if (!state) return null;
  if (state.finished || state.phase !== "speaking") {
    return { addr: "", index: state.currentSpeakerIndex ?? -1, finished: !!state.finished };
  }
  const alive = await getAliveShuffled(chainId, roomId);
  const speaker = alive[state.currentSpeakerIndex];
  return { addr: speaker?.wallet ?? "", index: state.currentSpeakerIndex, finished: false };
}

/** Force-advance the speaker and push the new speaker to room clients. */
export async function advanceAndBroadcast(
  chainId: number,
  roomId: string,
  dayCount: number
): Promise<void> {
  const alive = await getAliveShuffled(chainId, roomId);
  const newState = await ServerStore.advanceSpeaker(roomId, dayCount, alive.length, true, chainId);
  if (!newState) return;
  const nextSpeaker = alive[newState.currentSpeakerIndex];
  wsManager.broadcastToRoom(roomId, chainId, {
    type: "discussion-update",
    data: {
      currentSpeakerAddress: nextSpeaker?.wallet || null,
      currentSpeakerIndex: newState.currentSpeakerIndex,
      phase: newState.phase,
      finished: newState.finished,
    },
  });
}

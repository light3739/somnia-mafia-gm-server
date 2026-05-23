/**
 * ws/discussionChatRelay.ts — server side of the human DAY chat relay.
 * Persists the message into the agent prompt window (so agents read humans),
 * best-effort, and returns the payload to fan out to room peers. Returns null
 * ONLY to drop the message (missing/blank fields or a malformed roomKey).
 * Persistence failures — including redis being unavailable — never block the
 * fan-out: humans must still see each other even when agents are degraded.
 * Callers must not rethrow.
 */
import type { Redis } from "ioredis";
import { pushHumanChat } from "../agents/chat-store.js";

export interface DiscussionChatRelay {
  type: "discussion-chat";
  data?: { by?: string; name?: string; text?: string; day?: number };
}

export async function handleDiscussionChatRelay(
  redis: Pick<Redis, "rpush" | "ltrim"> | null,
  roomKey: string,
  event: DiscussionChatRelay
): Promise<{ type: "discussion-chat"; data: { by: string; name: string; text: string; day: number; ts: number } } | null> {
  const d = event.data;
  if (!d || !d.by || typeof d.text !== "string" || !d.text.trim()) return null;
  // roomKey is the internal "{chainId}:{roomId}" socket key — guard defensively.
  const [chainStr, roomId] = roomKey.split(":");
  const chainId = Number(chainStr);
  if (!Number.isInteger(chainId) || chainId <= 0 || !roomId) return null;

  const by = d.by.toLowerCase();
  const day = Number(d.day ?? 0);
  const ts = Date.now();

  // Persistence (so agents can read humans) is best-effort: a redis hiccup or
  // unavailability must NOT stop the fan-out below.
  if (redis) {
    try {
      await pushHumanChat(redis, chainId, roomId, { by, text: d.text, day });
    } catch {
      /* best-effort — still fan out */
    }
  }

  return {
    type: "discussion-chat",
    data: { by, name: d.name ?? by.slice(0, 8), text: d.text, day, ts },
  };
}

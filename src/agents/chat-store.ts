/**
 * agents/chat-store.ts — write human DAY chat into the same Redis list the
 * DayHandler reads for prompt context (agentChatPromptKey). Agent messages are
 * written by day.ts; this is the human side. Deliberately does NOT write the
 * agent provenance log (agentChatLogKey) — that stays agent-only for audit.
 */
import type { Redis } from "ioredis";
import { agentChatPromptKey } from "./redis-keys.js";

export interface HumanChatEntry {
  by: string;
  text: string;
  day: number;
}

export async function pushHumanChat(
  redis: Pick<Redis, "rpush" | "ltrim">,
  chainId: number,
  roomId: string,
  entry: HumanChatEntry
): Promise<void> {
  const key = agentChatPromptKey(chainId, roomId);
  const record = JSON.stringify({
    by: entry.by.toLowerCase(),
    text: entry.text,
    day: entry.day,
    ts: Date.now(),
  });
  await redis.rpush(key, record);
  await redis.ltrim(key, -20, -1);
}

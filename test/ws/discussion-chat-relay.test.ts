import { describe, it, expect } from "vitest";
import { handleDiscussionChatRelay } from "../../src/ws/discussionChatRelay.js";
import { agentChatPromptKey } from "../../src/agents/redis-keys.js";

class FakeRedis {
  lists = new Map<string, string[]>();
  async rpush(k: string, v: string) { const l = this.lists.get(k) ?? []; l.push(v); this.lists.set(k, l); return l.length; }
  async ltrim() { return "OK"; }
}

describe("handleDiscussionChatRelay", () => {
  it("persists to prompt window and returns peers payload", async () => {
    const redis = new FakeRedis();
    const out = await handleDiscussionChatRelay(redis as any, "50312:8", {
      type: "discussion-chat",
      data: { by: "0xAbc", name: "Alice", text: "morning", day: 2 },
    });
    expect(redis.lists.get(agentChatPromptKey(50312, "8"))).toHaveLength(1);
    expect(out).not.toBeNull();
    expect(out!.data.text).toBe("morning");
  });

  it("returns null (drops) when fields are missing", async () => {
    const redis = new FakeRedis();
    const out = await handleDiscussionChatRelay(redis as any, "50312:8", {
      type: "discussion-chat",
      data: { by: "0xAbc" },
    });
    expect(out).toBeNull();
    expect(redis.lists.size).toBe(0);
  });

  it("fans out (returns payload) even when redis is unavailable, without throwing", async () => {
    const out = await handleDiscussionChatRelay(null, "50312:8", {
      type: "discussion-chat",
      data: { by: "0xAbc", name: "A", text: "x", day: 1 },
    });
    expect(out).not.toBeNull();
    expect(out!.data.text).toBe("x");
  });
});

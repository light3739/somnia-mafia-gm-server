import { describe, it, expect } from "vitest";
import { pushHumanChat } from "../../src/agents/chat-store.js";
import { agentChatPromptKey } from "../../src/agents/redis-keys.js";

class FakeRedis {
  lists = new Map<string, string[]>();
  async rpush(key: string, value: string) {
    const l = this.lists.get(key) ?? [];
    l.push(value);
    this.lists.set(key, l);
    return l.length;
  }
  async ltrim(key: string, start: number, stop: number) {
    const l = this.lists.get(key);
    if (l) {
      const s = start < 0 ? Math.max(0, l.length + start) : start;
      const e = stop < 0 ? l.length + stop : stop;
      this.lists.set(key, l.slice(s, e + 1));
    }
    return "OK";
  }
}

describe("pushHumanChat", () => {
  it("appends a JSON entry to agentChatPromptKey and caps at 20", async () => {
    const r = new FakeRedis();
    await pushHumanChat(r as any, 50312, "8", { by: "0xAbc", text: "hi", day: 1 });
    const key = agentChatPromptKey(50312, "8");
    const stored = r.lists.get(key)!;
    expect(stored).toHaveLength(1);
    const parsed = JSON.parse(stored[0]);
    expect(parsed).toMatchObject({ by: "0xabc", text: "hi", day: 1 });
    expect(typeof parsed.ts).toBe("number");

    for (let i = 0; i < 25; i++) {
      await pushHumanChat(r as any, 50312, "8", { by: "0xAbc", text: `m${i}`, day: 1 });
    }
    expect(r.lists.get(key)!.length).toBe(20);
  });
});

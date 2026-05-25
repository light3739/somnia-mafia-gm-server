import { describe, it, expect, vi, beforeEach } from "vitest";
import { turnController } from "../../src/agents/turnController.js";
import { agentTurnLockKey } from "../../src/agents/redis-keys.js";

class FakeRedis {
  kv = new Map<string, string>();
  async set(key: string, _v: string, ...args: any[]) {
    const nx = args.map(String).map((s) => s.toUpperCase()).includes("NX");
    if (nx && this.kv.has(key)) return null;
    this.kv.set(key, "1");
    return "OK";
  }
}

beforeEach(() => turnController.reset());

it("no-op when not configured", async () => {
  await expect(turnController.onSpeakerChanged(50312, "8", 1)).resolves.toBeUndefined();
});

it("makes an agent speak then advances; stops at a human", async () => {
  const redis = new FakeRedis();
  const speak = vi.fn(async () => ({ handled: true }));
  const advance = vi.fn(async () => {});
  let call = 0;
  const getCurrentSpeaker = vi.fn(async () => {
    call++;
    if (call === 1) return { addr: "0xAgentA", index: 0, finished: false };
    return { addr: "0xHumanB", index: 1, finished: false };
  });
  const isAgent = vi.fn(async (_c: number, _r: string, addr: string) => addr === "0xAgentA");

  turnController.configure({ redis: redis as any, getCurrentSpeaker, isAgent, speakOneAgent: speak, advanceAndBroadcast: advance, capMs: 50 });
  await turnController.onSpeakerChanged(50312, "8", 1);

  expect(speak).toHaveBeenCalledTimes(1);
  expect(speak).toHaveBeenCalledWith(50312, "8", 1, "0xAgentA");
  expect(advance).toHaveBeenCalledTimes(1);
});

it("does not speak when the lock is already held", async () => {
  const redis = new FakeRedis();
  await redis.set(agentTurnLockKey(50312, "8", 1, 0), "1", "EX", 30, "NX");
  const speak = vi.fn(async () => ({ handled: true }));
  const advance = vi.fn(async () => {});
  turnController.configure({
    redis: redis as any,
    getCurrentSpeaker: async () => ({ addr: "0xAgentA", index: 0, finished: false }),
    isAgent: async () => true,
    speakOneAgent: speak,
    advanceAndBroadcast: advance,
    capMs: 50,
  });
  await turnController.onSpeakerChanged(50312, "8", 1);
  expect(speak).not.toHaveBeenCalled();
});

it("paces each agent turn to a minimum display time before advancing", async () => {
  const redis = new FakeRedis();
  const speak = vi.fn(async () => ({ handled: true })); // instant → pad kicks in
  const advance = vi.fn(async () => {});
  const sleep = vi.fn(async () => {});
  let call = 0;
  const getCurrentSpeaker = vi.fn(async () => {
    call++;
    if (call === 1) return { addr: "0xAgentA", index: 0, finished: false };
    return { addr: "", index: 1, finished: true };
  });
  turnController.configure({
    redis: redis as any,
    getCurrentSpeaker,
    isAgent: async () => true,
    speakOneAgent: speak,
    advanceAndBroadcast: advance,
    capMs: 50,
    paceMs: 9000,
    sleep,
  });
  await turnController.onSpeakerChanged(50312, "8", 1);
  expect(speak).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledTimes(1);
  // padded by ~paceMs (speak was instant) and BEFORE advancing
  expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
  expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(9000);
  expect(advance).toHaveBeenCalledTimes(1);
});

it("does not pad when paceMs is unset", async () => {
  const redis = new FakeRedis();
  const sleep = vi.fn(async () => {});
  let call = 0;
  turnController.configure({
    redis: redis as any,
    getCurrentSpeaker: async () => {
      call++;
      return call === 1
        ? { addr: "0xAgentA", index: 0, finished: false }
        : { addr: "", index: 1, finished: true };
    },
    isAgent: async () => true,
    speakOneAgent: async () => ({ handled: true }),
    advanceAndBroadcast: async () => {},
    capMs: 50,
    sleep,
  });
  await turnController.onSpeakerChanged(50312, "8", 1);
  expect(sleep).not.toHaveBeenCalled();
});

it("stops at finished without speaking", async () => {
  const redis = new FakeRedis();
  const speak = vi.fn(async () => ({ handled: true }));
  turnController.configure({
    redis: redis as any,
    getCurrentSpeaker: async () => ({ addr: "", index: 2, finished: true }),
    isAgent: async () => true,
    speakOneAgent: speak,
    advanceAndBroadcast: async () => {},
    capMs: 50,
  });
  await turnController.onSpeakerChanged(50312, "8", 1);
  expect(speak).not.toHaveBeenCalled();
});

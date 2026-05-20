/**
 * Unit tests for AgentDispatcher. Redis is faked in-memory; no chain.
 *
 * Coverage:
 *   - first dispatch claims the event slot, returns 'dispatched'
 *   - second dispatch with same coords is deduplicated
 *   - cursor (lastBlock) is written after a successful dispatch
 *   - each event.type hits its routing branch without error (skeleton stubs)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentDispatcher } from "../../src/agents/dispatcher.js";
import { eventProcessedKey, lastBlockKey } from "../../src/agents/redis-keys.js";
import type { AgentEvent } from "../../src/agents/events.js";

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async set(
    key: string,
    value: string,
    ...args: any[]
  ): Promise<"OK" | null> {
    // Parse "EX <seconds>" and "NX" if present
    let nx = false;
    let exSeconds: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "NX") nx = true;
      if (a === "EX") exSeconds = Number(args[i + 1]);
    }

    const existing = this.store.get(key);
    const now = Date.now();
    const stillAlive =
      existing && (existing.expiresAt == null || existing.expiresAt > now);

    if (nx && stillAlive) return null;

    this.store.set(key, {
      value,
      expiresAt: exSeconds != null ? now + exSeconds * 1000 : null,
    });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    if (!v) return null;
    if (v.expiresAt != null && v.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return v.value;
  }
}

const TX_A = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as const;
const TX_B = "0xbbbb000000000000000000000000000000000000000000000000000000000002" as const;
const DIAMOND = "0x031b6746155ce11c7b533935f4674f5fc4682338" as const;

function votingEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "VOTING_STARTED",
    chainId: 50312,
    roomId: "7",
    phaseId: "D3-VOTING",
    dayNumber: 3,
    blockNumber: 100,
    txHash: TX_A,
    logIndex: 0,
    ...(overrides as any),
  } as AgentEvent;
}

describe("AgentDispatcher", () => {
  let redis: FakeRedis;
  let dispatcher: AgentDispatcher;

  beforeEach(() => {
    redis = new FakeRedis();
    dispatcher = new AgentDispatcher({
      redis: redis as any,
      diamondByChain: new Map([[50312, DIAMOND]]),
    });
  });

  it("first dispatch returns 'dispatched' and writes the cursor", async () => {
    const ev = votingEvent();
    const out = await dispatcher.dispatch(ev);
    expect(out.kind).toBe("dispatched");

    const cursor = await redis.get(lastBlockKey(50312, DIAMOND));
    expect(cursor).toBe("100");

    const claim = await redis.get(
      eventProcessedKey(50312, TX_A, 0)
    );
    expect(claim).not.toBeNull();
  });

  it("re-dispatching the same (txHash, logIndex) is deduplicated", async () => {
    const ev = votingEvent();
    const first = await dispatcher.dispatch(ev);
    const second = await dispatcher.dispatch(ev);

    expect(first.kind).toBe("dispatched");
    expect(second.kind).toBe("duplicate");
  });

  it("different logIndex on the same tx is not deduplicated", async () => {
    const a = votingEvent({ logIndex: 0 } as any);
    const b = votingEvent({ logIndex: 1 } as any);
    const ra = await dispatcher.dispatch(a);
    const rb = await dispatcher.dispatch(b);
    expect(ra.kind).toBe("dispatched");
    expect(rb.kind).toBe("dispatched");
  });

  it("different txHash on the same logIndex is not deduplicated", async () => {
    const a = votingEvent({ txHash: TX_A } as any);
    const b = votingEvent({ txHash: TX_B } as any);
    const ra = await dispatcher.dispatch(a);
    const rb = await dispatcher.dispatch(b);
    expect(ra.kind).toBe("dispatched");
    expect(rb.kind).toBe("dispatched");
  });

  it("routes all four event types through skeleton stubs without error", async () => {
    const events: AgentEvent[] = [
      {
        type: "DAY_STARTED",
        chainId: 50312,
        roomId: "7",
        phaseId: "D1-DAY",
        dayNumber: 1,
        blockNumber: 10,
        txHash: TX_A,
        logIndex: 0,
      },
      {
        type: "VOTING_STARTED",
        chainId: 50312,
        roomId: "7",
        phaseId: "D1-VOTING",
        dayNumber: 1,
        blockNumber: 11,
        txHash: TX_A,
        logIndex: 1,
      },
      {
        type: "NIGHT_STARTED",
        chainId: 50312,
        roomId: "7",
        phaseId: "D1-NIGHT",
        dayNumber: 1,
        blockNumber: 12,
        txHash: TX_A,
        logIndex: 2,
      },
      {
        type: "GAME_ENDED",
        chainId: 50312,
        roomId: "7",
        phaseId: "ENDED",
        winCondition: "TOWN_WIN",
        blockNumber: 13,
        txHash: TX_A,
        logIndex: 3,
      },
    ];

    for (const e of events) {
      const out = await dispatcher.dispatch(e);
      expect(out.kind).toBe("dispatched");
    }

    // All four claims persisted
    expect(await redis.get(eventProcessedKey(50312, TX_A, 0))).not.toBeNull();
    expect(await redis.get(eventProcessedKey(50312, TX_A, 1))).not.toBeNull();
    expect(await redis.get(eventProcessedKey(50312, TX_A, 2))).not.toBeNull();
    expect(await redis.get(eventProcessedKey(50312, TX_A, 3))).not.toBeNull();

    // Cursor advanced to the last block we dispatched
    expect(await redis.get(lastBlockKey(50312, DIAMOND))).toBe("13");
  });
});

describe("AgentDispatcher pre-game routing", () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
  });

  function gameStarted(over: Partial<AgentEvent> = {}): AgentEvent {
    return {
      type: "GAME_STARTED",
      chainId: 50312,
      roomId: "9",
      phaseId: "SHUFFLING",
      blockNumber: 50,
      txHash: TX_A,
      logIndex: 0,
      ...(over as any),
    } as AgentEvent;
  }
  function deckRevealed(over: Partial<AgentEvent> = {}): AgentEvent {
    return {
      type: "DECK_REVEALED",
      chainId: 50312,
      roomId: "9",
      phaseId: "SHUFFLING",
      blockNumber: 51,
      txHash: TX_A,
      logIndex: 1,
      ...(over as any),
    } as AgentEvent;
  }
  function build(preGameHandler: any) {
    return new AgentDispatcher({
      redis: redis as any,
      diamondByChain: new Map([[50312, DIAMOND]]),
      preGameHandler,
    });
  }

  it("routes GAME_STARTED → handleShuffling then handleReveal", async () => {
    const handleShuffling = vi.fn(async () => []);
    const handleReveal = vi.fn(async () => []);
    const out = await build({ handleShuffling, handleReveal }).dispatch(gameStarted());
    expect(out.kind).toBe("dispatched");
    expect(handleShuffling).toHaveBeenCalledWith({ chainId: 50312, roomId: "9" });
    expect(handleReveal).toHaveBeenCalledWith({ chainId: 50312, roomId: "9" });
  });

  it("routes DECK_REVEALED → pre-game (re-entry / advance trigger)", async () => {
    const handleShuffling = vi.fn(async () => []);
    const handleReveal = vi.fn(async () => []);
    await build({ handleShuffling, handleReveal }).dispatch(deckRevealed());
    expect(handleShuffling).toHaveBeenCalledTimes(1);
    expect(handleReveal).toHaveBeenCalledTimes(1);
  });

  it("serialises pre-game per room — no concurrent shuffle", async () => {
    let active = 0;
    let maxActive = 0;
    const handleShuffling = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return [];
    });
    const handleReveal = vi.fn(async () => []);
    const dispatcher = build({ handleShuffling, handleReveal });
    await Promise.all([
      dispatcher.dispatch(gameStarted({ logIndex: 0 })),
      dispatcher.dispatch(deckRevealed({ logIndex: 1 })),
    ]);
    expect(maxActive).toBe(1); // mutex held — turns ran one at a time
    expect(handleShuffling).toHaveBeenCalledTimes(2);
    expect(handleReveal).toHaveBeenCalledTimes(2);
  });

  it("a throwing pre-game handler does not reject dispatch", async () => {
    const handleShuffling = vi.fn(async () => {
      throw new Error("boom");
    });
    const handleReveal = vi.fn(async () => []);
    const out = await build({ handleShuffling, handleReveal }).dispatch(gameStarted());
    expect(out.kind).toBe("dispatched"); // error swallowed, listener stays alive
  });
});

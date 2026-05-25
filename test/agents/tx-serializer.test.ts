import { describe, it, expect } from "vitest";
import { runExclusive } from "../../src/agents/tx-serializer.js";

const slow = (events: string[], id: string, ms: number) => async () => {
  events.push(`${id}:start`);
  await new Promise((r) => setTimeout(r, ms));
  events.push(`${id}:end`);
  return id;
};

describe("runExclusive", () => {
  it("serializes calls for the same key — second waits for the first to finish", async () => {
    const ev: string[] = [];
    const p1 = runExclusive("0xWALLET", slow(ev, "1", 30));
    const p2 = runExclusive("0xWALLET", slow(ev, "2", 5));
    await Promise.all([p1, p2]);
    expect(ev).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });

  it("runs different keys concurrently", async () => {
    const ev: string[] = [];
    await Promise.all([
      runExclusive("0xA", slow(ev, "A", 20)),
      runExclusive("0xB", slow(ev, "B", 20)),
    ]);
    // both started before either ended
    expect(ev.slice(0, 2).sort()).toEqual(["A:start", "B:start"]);
  });

  it("a rejection does not block the next call on the same key", async () => {
    await expect(
      runExclusive("0xA", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(runExclusive("0xA", async () => "ok")).resolves.toBe("ok");
  });

  it("treats the key case-insensitively (same wallet, mixed case)", async () => {
    const ev: string[] = [];
    await Promise.all([
      runExclusive("0xAbCd", slow(ev, "1", 25)),
      runExclusive("0xabcd", slow(ev, "2", 5)),
    ]);
    expect(ev).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });
});

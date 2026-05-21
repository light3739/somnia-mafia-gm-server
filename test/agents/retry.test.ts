/**
 * Unit tests for withRetry — used to retry createRequest when it reverts BEFORE
 * broadcasting a tx (gas-estimation revert = no tx sent = safe to retry).
 */
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/agents/retry.js";

describe("withRetry", () => {
  it("returns immediately on first success (no retry)", async () => {
    const fn = vi.fn(async () => "ok");
    const res = await withRetry(fn, { retries: 2, delayMs: 0 });
    expect(res).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });
    const res = await withRetry(fn, { retries: 2, delayMs: 0 });
    expect(res).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting retries", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });
    await expect(withRetry(fn, { retries: 2, delayMs: 0 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("fatal");
    });
    await expect(
      withRetry(fn, { retries: 5, delayMs: 0, shouldRetry: () => false })
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

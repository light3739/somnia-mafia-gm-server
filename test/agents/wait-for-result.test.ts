import { describe, it, expect, vi } from "vitest";
import { waitForLlmResult } from "../../src/agents/wait-for-result.js";

/**
 * The Somnia RPC delivers ResultReady logs unreliably (watchContractEvent starts
 * polling logs only FORWARD from the block it was created, so a result that lands
 * during the createRequest-receipt gap is missed forever → 60s timeout). The fix
 * races the event watch against a getResult poll, which reads current state and
 * cannot miss an already-landed result. These tests pin that race.
 */
describe("waitForLlmResult", () => {
  const noEvents = () => () => {};
  const noResult = async () => null;

  it("resolves with the event status when the event fires", async () => {
    const status = await waitForLlmResult({
      waitMs: 1000,
      pollMs: 100000, // poll never fires within the test
      requestId: 1n,
      label: "test",
      watchEvents: (onStatus) => {
        setTimeout(() => onStatus(2), 5);
        return () => {};
      },
      pollReady: noResult,
    });
    expect(status).toBe(2);
  });

  it("resolves via getResult poll when the event never arrives (the prod bug)", async () => {
    const status = await waitForLlmResult({
      waitMs: 1000,
      pollMs: 10,
      requestId: 1n,
      label: "test",
      watchEvents: noEvents, // event silently never delivered
      pollReady: async () => 2, // but the store has the result
    });
    expect(status).toBe(2);
  });

  it("resolves 0 (timeout) when neither event nor poll yields a result", async () => {
    const status = await waitForLlmResult({
      waitMs: 40,
      pollMs: 100000,
      requestId: 1n,
      label: "test",
      watchEvents: noEvents,
      pollReady: noResult,
    });
    expect(status).toBe(0);
  });

  it("settles once and unwatches/stops polling when event + poll both ready", async () => {
    let unwatchCalls = 0;
    let pollCalls = 0;
    await waitForLlmResult({
      waitMs: 1000,
      pollMs: 10,
      requestId: 1n,
      label: "test",
      watchEvents: (onStatus) => {
        setTimeout(() => onStatus(2), 5);
        return () => { unwatchCalls++; };
      },
      pollReady: async () => { pollCalls++; return 2; },
    });
    const pollsAtSettle = pollCalls;
    await new Promise((r) => setTimeout(r, 60)); // would allow ~6 more polls if not stopped
    expect(unwatchCalls).toBe(1);
    expect(pollCalls).toBe(pollsAtSettle); // polling stopped after settle
  });

  it("tolerates a transient poll error and resolves on the next poll", async () => {
    let n = 0;
    const status = await waitForLlmResult({
      waitMs: 1000,
      pollMs: 10,
      requestId: 1n,
      label: "test",
      watchEvents: noEvents,
      pollReady: async () => {
        n++;
        if (n === 1) throw new Error("transient RPC");
        return 2;
      },
    });
    expect(status).toBe(2);
  });
});

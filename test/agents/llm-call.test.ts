import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import type { Hex } from "viem";
import { inferStringOnSomnia } from "../../src/agents/llm-call.js";

const REQUESTER: Hex = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const TX_HASH: Hex = ("0x" + "ef".repeat(32)) as Hex;
const REQUEST_ID = 555n;

const REQUESTER_ABI = parseAbi([
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
]);

function buildRequestCreatedLog(requestId: bigint) {
  const topics = encodeEventTopics({
    abi: REQUESTER_ABI,
    eventName: "RequestCreated",
    args: { requestId, agentId: 12847293847561029384n },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }, { type: "address[]" }],
    [0n, "0x", []]
  );
  return { address: REQUESTER, topics, data };
}

function makeFakes(opts: {
  emit?: "ready" | "none";
  status?: number;
  resultsReady?: boolean;
  text?: string;
}) {
  const unsub = { v: false };
  const publicClient: any = {
    readContract: vi.fn(({ functionName }: any) => {
      if (functionName === "getRequestDeposit") return Promise.resolve(0n);
      if (functionName === "results") {
        // store getter returns positional [ready, status, text]
        return Promise.resolve([
          opts.resultsReady ?? true,
          opts.status ?? 2,
          opts.text ?? "vote for Bob",
        ]);
      }
      return Promise.resolve(0n);
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      logs: [buildRequestCreatedLog(REQUEST_ID)],
    }),
    watchContractEvent: vi.fn(({ eventName, onLogs }: any) => {
      if (opts.emit === "ready" && eventName === "ResultReady") {
        setImmediate(() =>
          onLogs([
            { args: { requestId: REQUEST_ID, status: opts.status ?? 2, text: opts.text ?? "vote for Bob" } },
          ])
        );
      }
      return () => {
        unsub.v = true;
      };
    }),
  };
  const walletClient: any = { writeContract: vi.fn().mockResolvedValue(TX_HASH) };
  return { publicClient, walletClient, unsub };
}

describe("inferStringOnSomnia", () => {
  const req = { prompt: "who is mafia?", system: "you are a player", allowedValues: ["Alice", "Bob"] };

  it("happy path: ResultReady event delivers the text", async () => {
    const fakes = makeFakes({ emit: "ready", text: "Bob" });
    const res = await inferStringOnSomnia(req, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 2_000,
    });
    expect(res.status).toBe(2);
    expect(res.text).toBe("Bob");
    expect(fakes.unsub.v).toBe(true);
  });

  it("resolves via results() poll when ResultReady never arrives (the voting bug)", async () => {
    // Event dropped by the Somnia RPC; result is in the store within ~1s on chain.
    const fakes = makeFakes({ emit: "none", text: "Alice" });
    const res = await inferStringOnSomnia(req, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 2_000,
    });
    expect(res.status).toBe(2);
    expect(res.text).toBe("Alice");
    expect(fakes.unsub.v).toBe(true);
  });

  it("timeout: text=null status=0 when nothing is ready", async () => {
    const fakes = makeFakes({ emit: "none", resultsReady: false });
    const res = await inferStringOnSomnia(req, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 80,
    });
    expect(res.status).toBe(0);
    expect(res.text).toBeNull();
  });
});

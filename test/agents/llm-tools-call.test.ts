import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import type { Hex } from "viem";
import { inferToolsChatOnSomnia } from "../../src/agents/llm-tools-call.js";

const REQUESTER: Hex = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const TX_HASH: Hex = ("0x" + "cd".repeat(32)) as Hex;
const REQUEST_ID = 1234n;
const NIGHT_KILL_CALLDATA = ("0x2461aa4c" + "00".repeat(32)) as Hex;

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
  emit?: "ready" | "failed" | "none";
  status?: number;
  resultReady?: boolean;
  pendingToolCalls?: Hex[];
}) {
  const unsubscribed = { ready: false, failed: false };
  const publicClient: any = {
    readContract: vi.fn(({ functionName }: any) => {
      if (functionName === "getRequestDeposit") return Promise.resolve(0n);
      if (functionName === "getResult") {
        return Promise.resolve({
          ready: opts.resultReady ?? true,
          status: opts.status ?? 2,
          finishReason: "tool_calls",
          response: "",
          pendingToolCallIds: ["id0"],
          pendingToolCalls: opts.pendingToolCalls ?? [NIGHT_KILL_CALLDATA],
        });
      }
      return Promise.resolve(0n);
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      logs: [buildRequestCreatedLog(REQUEST_ID)],
    }),
    watchContractEvent: vi.fn(({ eventName, onLogs }: any) => {
      const fire = () =>
        onLogs([{ args: { requestId: REQUEST_ID, status: opts.status ?? 2 } }]);
      const target = opts.emit === "failed" ? "ToolsResultFailed" : "ToolsResultReady";
      if ((opts.emit === "ready" || opts.emit === "failed") && eventName === target) {
        setImmediate(fire);
      }
      return () => {
        if (eventName === "ToolsResultReady") unsubscribed.ready = true;
        if (eventName === "ToolsResultFailed") unsubscribed.failed = true;
      };
    }),
  };
  const walletClient: any = { writeContract: vi.fn().mockResolvedValue(TX_HASH) };
  return { publicClient, walletClient, unsubscribed };
}

describe("inferToolsChatOnSomnia", () => {
  const baseReq = {
    roles: ["system", "user"],
    messages: ["s", "u"],
    mcpServerUrls: [],
    onchainTools: [{ signature: "skip()", description: "skip" }],
    maxIterations: 1,
    chainOfThought: false,
  };

  it("happy path: ToolsResultReady event delivers the tool call", async () => {
    const fakes = makeFakes({ emit: "ready" });
    const res = await inferToolsChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 2_000,
    });
    expect(res.status).toEqual(2);
    expect(res.result?.finishReason).toEqual("tool_calls");
    expect(res.result?.pendingToolCalls[0]).toEqual(NIGHT_KILL_CALLDATA);
    expect(fakes.unsubscribed.ready).toEqual(true);
  });

  it("resolves via getResult poll when ToolsResultReady never arrives (the night kill bug)", async () => {
    // Event silently dropped by the Somnia RPC — the poll must still deliver the kill.
    const fakes = makeFakes({ emit: "none" });
    const res = await inferToolsChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 2_000,
    });
    expect(res.status).toEqual(2);
    expect(res.result).not.toBeNull();
    expect(res.result?.pendingToolCalls[0]).toEqual(NIGHT_KILL_CALLDATA);
    expect(fakes.unsubscribed.ready).toEqual(true);
  });

  it("timeout returns result=null with status=0 when nothing is ready", async () => {
    const fakes = makeFakes({ emit: "none", resultReady: false });
    const res = await inferToolsChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 80,
    });
    expect(res.status).toEqual(0);
    expect(res.result).toBeNull();
    expect(fakes.unsubscribed.ready).toEqual(true);
    expect(fakes.unsubscribed.failed).toEqual(true);
  });
});

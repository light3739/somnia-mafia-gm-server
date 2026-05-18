import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex } from "viem";
import type { Hex } from "viem";
import {
  inferChatOnSomnia,
  encodeInferChatPayload,
} from "../../src/agents/llm-chat-call.js";

const REQUESTER: Hex = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const CHAT_STORE: Hex = "0x07f351efdbd4478e3f31c2fdbd91d9e97ce76028";
const TX_HASH: Hex = ("0x" + "ab".repeat(32)) as Hex;
const REQUEST_ID = 99n;

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
  return {
    address: REQUESTER,
    topics,
    data,
  };
}

function makeFakes(opts: {
  resultText?: string;
  emitImmediately?: boolean;
  emitAfterMs?: number;
  status?: 2 | 3;
  failedEvent?: boolean;
}) {
  const unsubscribedReady = { v: false };
  const unsubscribedFailed = { v: false };

  const publicClient: any = {
    readContract: vi.fn().mockImplementation(({ functionName }: any) => {
      if (functionName === "getRequestDeposit") return Promise.resolve(0n);
      if (functionName === "getResult") {
        return Promise.resolve({
          ready: true,
          status: opts.status ?? 2,
          response: opts.resultText ?? "",
        });
      }
      return Promise.resolve(0n);
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      logs: [buildRequestCreatedLog(REQUEST_ID)],
    }),
    watchContractEvent: vi.fn(({ eventName, onLogs }: any) => {
      const fire = () => {
        onLogs([{ args: { requestId: REQUEST_ID, status: opts.status ?? 2 } }]);
      };
      const targetEvent = opts.failedEvent ? "ChatResultFailed" : "ChatResultReady";
      if (eventName === targetEvent) {
        if (opts.emitImmediately) {
          setImmediate(fire);
        } else if (opts.emitAfterMs) {
          setTimeout(fire, opts.emitAfterMs);
        }
      }
      return () => {
        if (eventName === "ChatResultReady") unsubscribedReady.v = true;
        if (eventName === "ChatResultFailed") unsubscribedFailed.v = true;
      };
    }),
  };

  const walletClient: any = {
    writeContract: vi.fn().mockResolvedValue(TX_HASH),
  };

  return {
    publicClient,
    walletClient,
    unsubscribedReady,
    unsubscribedFailed,
  };
}

describe("inferChatOnSomnia", () => {
  const baseReq = { roles: ["system", "user"], messages: ["s", "u"], chainOfThought: false };

  it("happy path returns the decoded text + requestId + txHash", async () => {
    const fakes = makeFakes({ resultText: "hello world", emitImmediately: true });
    const res = await inferChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 2_000,
      gasPriceGwei: 10,
    });
    expect(res.status).toEqual(2);
    expect(res.requestId).toEqual(REQUEST_ID);
    expect(res.txHash).toEqual(TX_HASH);
    expect(res.result?.response).toEqual("hello world");
    expect(fakes.unsubscribedReady.v).toEqual(true);
    expect(fakes.unsubscribedFailed.v).toEqual(true);
  });

  it("timeout returns result=null with status=0; unsubscribes both watchers", async () => {
    const fakes = makeFakes({});
    const res = await inferChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 100,
      gasPriceGwei: 10,
    });
    expect(res.status).toEqual(0);
    expect(res.result).toBeNull();
    expect(fakes.unsubscribedReady.v).toEqual(true);
    expect(fakes.unsubscribedFailed.v).toEqual(true);
  });

  it("late ChatResultReady arriving after the timeout is ignored", async () => {
    const fakes = makeFakes({ emitAfterMs: 200, resultText: "late" });
    const res = await inferChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 50,
      gasPriceGwei: 10,
    });
    expect(res.status).toEqual(0);
    expect(res.result).toBeNull();
    await new Promise((r) => setTimeout(r, 250));
    expect(fakes.unsubscribedReady.v).toEqual(true);
  });

  it("failed-status event resolves result=null with returned status", async () => {
    const fakes = makeFakes({ emitImmediately: true, status: 3, failedEvent: true });
    const res = await inferChatOnSomnia(baseReq, {
      publicClient: fakes.publicClient,
      walletClient: fakes.walletClient,
      chainId: 50312,
      waitMs: 2_000,
      gasPriceGwei: 10,
    });
    expect(res.status).toEqual(3);
    expect(res.result).toBeNull();
  });
});

describe("encodeInferChatPayload", () => {
  it("starts with the inferChat selector (4 bytes)", () => {
    const enc = encodeInferChatPayload({
      roles: ["system", "user"],
      messages: ["s", "u"],
      chainOfThought: false,
    });
    expect(enc.startsWith("0x")).toEqual(true);
    expect(enc.length).toBeGreaterThan(10);
    const selector = enc.slice(0, 10);
    expect(selector.length).toEqual(10);
  });

  it("is deterministic for the same inputs", () => {
    const a = encodeInferChatPayload({ roles: ["s"], messages: ["m"], chainOfThought: true });
    const b = encodeInferChatPayload({ roles: ["s"], messages: ["m"], chainOfThought: true });
    expect(a).toEqual(b);
  });
});

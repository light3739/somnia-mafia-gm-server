/**
 * agents/llm-chat-call.ts — Reusable Somnia inferChat call.
 *
 * Companion to llm-call.ts (inferString) and llm-tools-call.ts (inferToolsChat).
 * Wraps the AgentRequester.createRequest → wait-for-ChatResultReady → fetch
 * stored single-string response flow.
 *
 * Differences from inferString flow:
 *   - selector = inferChat(string[],string[],bool)
 *   - sink contract = LLMChatResultStore (single-string getResult)
 *   - event we watch = ChatResultReady (signal only — full text fetched via getResult)
 *
 * Reuses HANDLE_RESPONSE_SELECTOR from llm-call.ts (same AgentRequester ABI).
 *
 * Late ChatResultReady events arriving after waitMs are dropped (the timer's
 * unwatch handles them — once `settled` resolves, listeners are detached).
 */
import {
  encodeAbiParameters,
  decodeEventLog,
  parseAbi,
  parseAbiParameters,
  parseEther,
  parseGwei,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { logger } from "../utils/logger.js";
import { HANDLE_RESPONSE_SELECTOR, waitForReceiptWithTimeout } from "./llm-call.js";
import { withRetry } from "./retry.js";
import { waitForLlmResult } from "./wait-for-result.js";

const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
]);

const CHAT_STORE_ABI = parseAbi([
  "event ChatResultReady(uint256 indexed requestId, uint8 status)",
  "event ChatResultFailed(uint256 indexed requestId, uint8 status)",
  "function getResult(uint256 requestId) view returns ((bool ready, uint8 status, string response))",
]);

const INFER_CHAT_SELECTOR = toFunctionSelector(
  "inferChat(string[],string[],bool)"
) as Hex;

export interface ChainChatLlmConfig {
  agentRequester: Address;
  chatStore: Address;
  agentId: bigint;
}

const DEFAULTS_50312: ChainChatLlmConfig = {
  agentRequester: "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776",
  chatStore: "0x02e21ff2235adc1df186cabf06e27b75091f0687", // fixed store (defensive decode); was 0x07f351
  agentId: 12847293847561029384n,
};

const DEFAULTS_5031: ChainChatLlmConfig = {
  agentRequester: "0x5E5205CF39E766118C01636bED000A54D93163E6",
  chatStore: "0x0000000000000000000000000000000000000000",
  agentId: 0n,
};

export function getChainChatLlmConfig(chainId: number): ChainChatLlmConfig {
  const envRequester = process.env[`LLM_REQUESTER_${chainId}`];
  const envStore = process.env[`LLM_CHAT_STORE_${chainId}`];
  const envAgentId = process.env[`LLM_CHAT_AGENT_ID_${chainId}`] ?? process.env.LLM_CHAT_AGENT_ID;

  const base =
    chainId === 50312 ? DEFAULTS_50312 : chainId === 5031 ? DEFAULTS_5031 : null;
  if (!base && !(envRequester && envStore && envAgentId)) {
    throw new Error(
      `[agents/llm-chat] No default config for chainId ${chainId} and env LLM_REQUESTER_${chainId}/LLM_CHAT_STORE_${chainId}/LLM_CHAT_AGENT_ID_${chainId} not all set`
    );
  }
  return {
    agentRequester: (envRequester ?? base!.agentRequester) as Address,
    chatStore: (envStore ?? base!.chatStore) as Address,
    agentId: envAgentId ? BigInt(envAgentId) : base!.agentId,
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Whether DAY chat (inferChat) is usable on a chain — i.e. a non-zero LLM chat
 * store is configured (via env or a built-in default). Mainnet (5031) has no
 * deployed store (zero-address default) → returns false, so the day subsystem
 * can skip DAY chat there instead of crashing a dual-chain deployment.
 */
export function hasUsableChatStore(chainId: number): boolean {
  try {
    const cfg = getChainChatLlmConfig(chainId);
    return !!cfg.chatStore && cfg.chatStore.toLowerCase() !== ZERO_ADDRESS;
  } catch {
    return false;
  }
}

export interface InferChatRequest {
  roles: string[];
  messages: string[];
  chainOfThought?: boolean;
}

export interface InferChatOpts {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chainId: number;
  /** Override default 25s wait (observed Somnia chat latency 3.8-5.8s; F5 tuning). */
  waitMs?: number;
  gasPriceGwei?: number;
  llmConfig?: ChainChatLlmConfig;
}

export interface ChatResultData {
  response: string;
  status: number;
}

export interface InferChatResult {
  /** `null` on timeout / non-success. Caller picks deterministic fallback / SKIP. */
  result: ChatResultData | null;
  status: number;
  requestId: bigint;
  txHash: Hex;
  latencySec: number;
}

export async function inferChatOnSomnia(
  req: InferChatRequest,
  opts: InferChatOpts
): Promise<InferChatResult> {
  const { publicClient, walletClient, chainId } = opts;
  const waitMs = opts.waitMs ?? 25_000;
  const gasPriceGwei = opts.gasPriceGwei ?? 10;
  const cfg = opts.llmConfig ?? getChainChatLlmConfig(chainId);

  if (req.roles.length !== req.messages.length) {
    throw new Error(
      `[agents/llm-chat] roles.length (${req.roles.length}) !== messages.length (${req.messages.length})`
    );
  }

  const payload = encodeInferChatPayload({
    roles: req.roles,
    messages: req.messages,
    chainOfThought: req.chainOfThought ?? false,
  });

  const reserve = await publicClient.readContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "getRequestDeposit",
  });
  const deposit = reserve + parseEther("0.07") * 3n;

  const start = Date.now();
  // Retry across gas-estimation reverts ONLY (thrown before broadcast → no value
  // spent → cannot double-spend). Receipt wait is time-capped so a stuck tx can't
  // hang the agent's DAY turn forever.
  const txHash = await withRetry(
    () =>
      walletClient.writeContract({
        address: cfg.agentRequester,
        abi: REQUESTER_ABI,
        functionName: "createRequest",
        args: [cfg.agentId, cfg.chatStore, HANDLE_RESPONSE_SELECTOR, payload],
        value: deposit,
        gasPrice: parseGwei(String(gasPriceGwei)),
      } as any),
    { retries: 1, delayMs: 1500 }
  );

  const receipt = await waitForReceiptWithTimeout(publicClient, txHash);
  if (receipt.status !== "success") {
    throw new Error(`createRequest reverted (tx ${txHash})`);
  }

  let requestId: bigint | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.agentRequester.toLowerCase()) continue;
    try {
      const d = decodeEventLog({
        abi: REQUESTER_ABI,
        topics: log.topics,
        data: log.data,
      });
      if (d.eventName === "RequestCreated") {
        requestId = d.args.requestId as bigint;
        break;
      }
    } catch {
      /* skip non-matching logs */
    }
  }
  if (!requestId) throw new Error(`RequestCreated event missing in tx ${txHash}`);

  const reqId = requestId;
  // Race the ChatResultReady event against a getResult poll — the Somnia RPC
  // drops the event when the subcommittee callback lands during the
  // createRequest→receipt gap (this is why agents sometimes silently skip a vote
  // or a DAY message). See agents/wait-for-result.ts.
  const outcomeStatus = await waitForLlmResult({
    waitMs,
    requestId: reqId,
    label: "llm-chat",
    watchEvents: (onStatus, onError) => {
      const unwatchReady = publicClient.watchContractEvent({
        address: cfg.chatStore,
        abi: CHAT_STORE_ABI,
        eventName: "ChatResultReady",
        args: { requestId: reqId },
        onLogs: (logs) => {
          for (const log of logs) onStatus((log.args as { status: number }).status);
        },
        onError,
      });
      const unwatchFailed = publicClient.watchContractEvent({
        address: cfg.chatStore,
        abi: CHAT_STORE_ABI,
        eventName: "ChatResultFailed",
        args: { requestId: reqId },
        onLogs: (logs) => {
          for (const log of logs) onStatus((log.args as { status: number }).status);
        },
        onError,
      });
      return () => {
        try { unwatchReady(); } catch { /* idempotent */ }
        try { unwatchFailed(); } catch { /* idempotent */ }
      };
    },
    pollReady: async () => {
      const r = (await publicClient.readContract({
        address: cfg.chatStore,
        abi: CHAT_STORE_ABI,
        functionName: "getResult",
        args: [reqId],
      })) as { ready: boolean; status: number; response: string };
      return r.ready ? Number(r.status) : null;
    },
  });

  if (outcomeStatus !== 2) {
    return {
      result: null,
      status: outcomeStatus,
      requestId,
      txHash,
      latencySec: (Date.now() - start) / 1000,
    };
  }

  const stored = (await publicClient.readContract({
    address: cfg.chatStore,
    abi: CHAT_STORE_ABI,
    functionName: "getResult",
    args: [requestId],
  })) as { ready: boolean; status: number; response: string };

  return {
    result: { response: stored.response, status: stored.status },
    status: outcomeStatus,
    requestId,
    txHash,
    latencySec: (Date.now() - start) / 1000,
  };
}

export function encodeInferChatPayload(args: {
  roles: string[];
  messages: string[];
  chainOfThought: boolean;
}): Hex {
  const encoded = encodeAbiParameters(
    parseAbiParameters("string[], string[], bool"),
    [args.roles, args.messages, args.chainOfThought]
  );
  return (INFER_CHAT_SELECTOR + encoded.slice(2)) as Hex;
}

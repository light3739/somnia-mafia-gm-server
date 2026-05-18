/**
 * agents/llm-tools-call.ts — Reusable Somnia inferToolsChat call.
 *
 * Companion to llm-call.ts. Wraps the AgentRequester.createRequest →
 * wait-for-ToolsResultReady → fetch-StoredResult flow into one async function
 * so phase handlers (night.ts) can pick a role-gated tool calldata without
 * re-implementing deposit math, payload encoding, or WS dance.
 *
 * Differences from inferString flow:
 *   - selector = inferToolsChat(string[],string[],string[],(string,string)[],uint256,bool)
 *   - sink contract = LLMToolsResultStore (decodes 6-tuple response)
 *   - event we watch = ToolsResultReady (signal only — full data fetched via getResult)
 *
 * The handleResponse selector on LLMToolsResultStore is identical to the one
 * on LLMResultStore (same AgentRequester ABI surface), so we reuse it.
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
import { HANDLE_RESPONSE_SELECTOR } from "./llm-call.js";

const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
]);

const TOOLS_STORE_ABI = parseAbi([
  "event ToolsResultReady(uint256 indexed requestId, uint8 status, string finishReason, uint256 toolCallCount)",
  "event ToolsResultFailed(uint256 indexed requestId, uint8 status)",
  "function getResult(uint256 requestId) view returns ((bool ready, uint8 status, string finishReason, string response, string[] pendingToolCallIds, bytes[] pendingToolCalls))",
]);

const INFER_TOOLS_CHAT_SELECTOR = toFunctionSelector(
  "inferToolsChat(string[],string[],string[],(string,string)[],uint256,bool)"
) as Hex;

/** Per-chain endpoints for the tools-chat flow. */
export interface ChainToolsLlmConfig {
  agentRequester: Address;
  toolsStore: Address;
  agentId: bigint;
}

const DEFAULTS_50312: ChainToolsLlmConfig = {
  agentRequester: "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776",
  toolsStore: "0x85e7e0e86d0a2d73c099f7a949eba88f84ebde99",
  agentId: 12847293847561029384n,
};

const DEFAULTS_5031: ChainToolsLlmConfig = {
  agentRequester: "0x5E5205CF39E766118C01636bED000A54D93163E6",
  toolsStore: "0x0000000000000000000000000000000000000000", // override via LLM_TOOLS_STORE_5031
  agentId: 0n, // override via LLM_AGENT_ID_5031
};

export function getChainToolsLlmConfig(chainId: number): ChainToolsLlmConfig {
  const envRequester = process.env[`LLM_REQUESTER_${chainId}`];
  const envStore = process.env[`LLM_TOOLS_STORE_${chainId}`];
  const envAgentId = process.env[`LLM_AGENT_ID_${chainId}`];

  const base =
    chainId === 50312 ? DEFAULTS_50312 : chainId === 5031 ? DEFAULTS_5031 : null;
  if (!base && !(envRequester && envStore && envAgentId)) {
    throw new Error(
      `[agents/llm-tools] No default config for chainId ${chainId} and env LLM_REQUESTER_${chainId}/LLM_TOOLS_STORE_${chainId}/LLM_AGENT_ID_${chainId} not all set`
    );
  }
  return {
    agentRequester: (envRequester ?? base!.agentRequester) as Address,
    toolsStore: (envStore ?? base!.toolsStore) as Address,
    agentId: envAgentId ? BigInt(envAgentId) : base!.agentId,
  };
}

export interface OnchainTool {
  /** Solidity-style signature, e.g. `nightKill(uint256,address)`. */
  signature: string;
  /** Human-readable description for the LLM. */
  description: string;
}

export interface InferToolsChatRequest {
  /** Chat roles — typically `["system", "user"]`. */
  roles: string[];
  /** Chat messages — same length as `roles`. */
  messages: string[];
  /** Optional MCP server URLs for extra context. */
  mcpServerUrls?: string[];
  /** Tools the LLM may pick from. Role-gated by caller. */
  onchainTools: OnchainTool[];
  /** Hard ceiling on agentic loop iterations. NIGHT uses 1. */
  maxIterations: number;
  /** Whether to emit chain-of-thought reasoning. */
  chainOfThought?: boolean;
}

export interface InferToolsChatOpts {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chainId: number;
  /** Override default 120s wait (tools-chat is slower than inferString). */
  waitMs?: number;
  /** Override default gas price (gwei). */
  gasPriceGwei?: number;
  /** Override resolved config (tests inject mocks). */
  llmConfig?: ChainToolsLlmConfig;
}

export interface ToolsResult {
  /** "tool_calls" if LLM picked a tool, "stop" if no tool, "length" on truncation. */
  finishReason: string;
  /** Free-form response. Empty when `finishReason === "tool_calls"`. */
  response: string;
  /** Per-tool ID strings from the LLM. */
  pendingToolCallIds: string[];
  /** Per-tool ABI-encoded calldata (function selector + args). */
  pendingToolCalls: Hex[];
  /** Underlying AgentRequester status code. */
  status: number;
}

export interface InferToolsChatResult {
  /** `null` on timeout / non-success. Caller picks deterministic fallback. */
  result: ToolsResult | null;
  status: number;
  requestId: bigint;
  /** Tx hash of createRequest (for audit trail). */
  txHash: Hex;
  latencySec: number;
}

/**
 * Fire one inferToolsChat request and wait for its callback. On timeout or
 * non-success status, returns `{ result: null }` — caller decides fallback.
 */
export async function inferToolsChatOnSomnia(
  req: InferToolsChatRequest,
  opts: InferToolsChatOpts
): Promise<InferToolsChatResult> {
  const { publicClient, walletClient, chainId } = opts;
  const waitMs = opts.waitMs ?? 120_000;
  const gasPriceGwei = opts.gasPriceGwei ?? 10;
  const cfg = opts.llmConfig ?? getChainToolsLlmConfig(chainId);

  if (req.roles.length !== req.messages.length) {
    throw new Error(
      `[agents/llm-tools] roles.length (${req.roles.length}) !== messages.length (${req.messages.length})`
    );
  }

  const payload = encodeInferToolsChatPayload({
    roles: req.roles,
    messages: req.messages,
    mcpServerUrls: req.mcpServerUrls ?? [],
    onchainTools: req.onchainTools,
    maxIterations: BigInt(req.maxIterations),
    chainOfThought: req.chainOfThought ?? false,
  });

  const reserve = await publicClient.readContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "getRequestDeposit",
  });
  // Same subcommittee=3 as inferString — verified in 4e smoke.
  const deposit = reserve + parseEther("0.07") * 3n;

  const start = Date.now();
  const txHash = await walletClient.writeContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "createRequest",
    args: [cfg.agentId, cfg.toolsStore, HANDLE_RESPONSE_SELECTOR, payload],
    value: deposit,
    gasPrice: parseGwei(String(gasPriceGwei)),
  } as any);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
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

  const outcomeStatus = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      unwatchReady();
      unwatchFailed();
      logger.warn(
        { requestId: requestId!.toString(), waitMs },
        "[agents/llm-tools] ToolsResultReady timeout — falling back"
      );
      resolve(0);
    }, waitMs);

    const unwatchReady = publicClient.watchContractEvent({
      address: cfg.toolsStore,
      abi: TOOLS_STORE_ABI,
      eventName: "ToolsResultReady",
      args: { requestId },
      onLogs: (logs) => {
        for (const log of logs) {
          const { status } = log.args as { status: number };
          clearTimeout(timer);
          unwatchReady();
          unwatchFailed();
          resolve(status);
        }
      },
      onError: (e) => {
        clearTimeout(timer);
        unwatchReady();
        unwatchFailed();
        reject(e);
      },
    });

    const unwatchFailed = publicClient.watchContractEvent({
      address: cfg.toolsStore,
      abi: TOOLS_STORE_ABI,
      eventName: "ToolsResultFailed",
      args: { requestId },
      onLogs: (logs) => {
        for (const log of logs) {
          const { status } = log.args as { status: number };
          clearTimeout(timer);
          unwatchReady();
          unwatchFailed();
          resolve(status);
        }
      },
      onError: (e) => {
        clearTimeout(timer);
        unwatchReady();
        unwatchFailed();
        reject(e);
      },
    });
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
    address: cfg.toolsStore,
    abi: TOOLS_STORE_ABI,
    functionName: "getResult",
    args: [requestId],
  })) as {
    ready: boolean;
    status: number;
    finishReason: string;
    response: string;
    pendingToolCallIds: readonly string[];
    pendingToolCalls: readonly Hex[];
  };

  return {
    result: {
      finishReason: stored.finishReason,
      response: stored.response,
      pendingToolCallIds: [...stored.pendingToolCallIds],
      pendingToolCalls: [...stored.pendingToolCalls],
      status: stored.status,
    },
    status: outcomeStatus,
    requestId,
    txHash,
    latencySec: (Date.now() - start) / 1000,
  };
}

export function encodeInferToolsChatPayload(args: {
  roles: string[];
  messages: string[];
  mcpServerUrls: string[];
  onchainTools: OnchainTool[];
  maxIterations: bigint;
  chainOfThought: boolean;
}): Hex {
  // OnchainTool encoded as a 2-tuple [signature, description] — viem positional.
  const tools = args.onchainTools.map(
    (t) => [t.signature, t.description] as [string, string]
  );
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "string[], string[], string[], (string,string)[], uint256, bool"
    ),
    [
      args.roles,
      args.messages,
      args.mcpServerUrls,
      tools,
      args.maxIterations,
      args.chainOfThought,
    ]
  );
  return (INFER_TOOLS_CHAT_SELECTOR + encoded.slice(2)) as Hex;
}

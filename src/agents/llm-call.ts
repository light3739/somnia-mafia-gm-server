/**
 * agents/llm-call.ts — Reusable Somnia LLM Inference call.
 *
 * Wraps the AgentRequester.createRequest → wait-for-ResultReady → decoded-text
 * flow into a single async function so phase handlers (voting.ts later
 * night/day handlers) can call it without re-implementing the deposit math,
 * payload encoding, or WS subscription dance.
 *
 * Per-chain configuration:
 *   - AgentRequester address and the LLMResultStore address differ across
 *     testnet/mainnet. Defaults match the memory addresses for chain 50312;
 *     other chains require env overrides.
 *
 * Off-chain timeout (default 90s) falls through to caller — `text` will be
 * `null` so resolveDecision can pick a deterministic fallback target. This
 * matches the spike-verified behaviour from agent-vote-spike.ts.
 *
 * Ported from SomniaMafia/e2e-bots/llm-call.ts.
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

const REQUESTER_ABI = parseAbi([
  "function createRequest(uint256 agentId, address callbackAddress, bytes4 callbackSelector, bytes payload) payable returns (uint256)",
  "function getRequestDeposit() view returns (uint256)",
  "event RequestCreated(uint256 indexed requestId, uint256 indexed agentId, uint256 perAgentBudget, bytes payload, address[] subcommittee)",
]);

const STORE_ABI = parseAbi([
  "event ResultReady(uint256 indexed requestId, uint8 status, string text)",
]);

const INFER_STRING_SELECTOR = toFunctionSelector(
  "inferString(string,string,bool,string[])"
) as Hex;

/**
 * Selector of LLMResultStore.handleResponse — the callback that AgentRequester
 * invokes once the subcommittee returns. We compute it from the full signature
 * (including the nested Request struct) so it stays in sync with on-chain types.
 */
const HANDLE_RESPONSE_SIG =
  "handleResponse(uint256,(address,bytes,uint8,uint256,uint256,uint256)[],uint8,(uint256,address,address,bytes4,address[],(address,bytes,uint8,uint256,uint256,uint256)[],uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint256,uint256))";
export const HANDLE_RESPONSE_SELECTOR = toFunctionSelector(
  HANDLE_RESPONSE_SIG
) as Hex;

/** Per-chain LLM endpoint set. Defaults populated from memory; overrideable via env. */
export interface ChainLlmConfig {
  /** Somnia AgentRequester address (the "RPC" for inference). */
  agentRequester: Address;
  /** Our LLMResultStore — receives the ResultReady event. */
  store: Address;
  /** Inference agent ID (model selection). */
  agentId: bigint;
}

const DEFAULTS_50312: ChainLlmConfig = {
  agentRequester: "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776",
  store: "0xb2f30e10454668c8c0c6040d1f3fc9b6ebee0649",
  agentId: 12847293847561029384n,
};

const DEFAULTS_5031: ChainLlmConfig = {
  // Memory: mainnet AgentRequester verified; mainnet store/agentId require env.
  agentRequester: "0x5E5205CF39E766118C01636bED000A54D93163E6",
  store: "0x0000000000000000000000000000000000000000", // must be overridden via LLM_STORE_5031
  agentId: 0n, // must be overridden via LLM_AGENT_ID_5031
};

export function getChainLlmConfig(chainId: number): ChainLlmConfig {
  const envRequester = process.env[`LLM_REQUESTER_${chainId}`];
  const envStore = process.env[`LLM_STORE_${chainId}`];
  const envAgentId = process.env[`LLM_AGENT_ID_${chainId}`];

  const base =
    chainId === 50312 ? DEFAULTS_50312 : chainId === 5031 ? DEFAULTS_5031 : null;
  if (!base && !(envRequester && envStore && envAgentId)) {
    throw new Error(
      `[agents/llm] No default config for chainId ${chainId} and env LLM_REQUESTER_${chainId}/LLM_STORE_${chainId}/LLM_AGENT_ID_${chainId} not all set`
    );
  }
  return {
    agentRequester: (envRequester ?? base!.agentRequester) as Address,
    store: (envStore ?? base!.store) as Address,
    agentId: envAgentId ? BigInt(envAgentId) : base!.agentId,
  };
}

export interface InferStringRequest {
  prompt: string;
  system?: string;
  chainOfThought?: boolean;
  /** Constrains LLM output to one of these values. Strongly recommended. */
  allowedValues?: string[];
}

export interface InferStringOpts {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chainId: number;
  /** Override default 90s wait. */
  waitMs?: number;
  /** Override default gas price (gwei). */
  gasPriceGwei?: number;
  /** Override resolved llm config (tests inject mocks). */
  llmConfig?: ChainLlmConfig;
}

export interface InferStringResult {
  /** LLM-generated string. `null` if status != Success or timeout. */
  text: string | null;
  status: number;
  requestId: bigint;
  /** Tx hash of createRequest (for audit trail). */
  txHash: Hex;
  /** Wall-clock seconds from tx send to ResultReady (or timeout). */
  latencySec: number;
}

/**
 * Fire one inferString request and wait for its callback. Returns
 * `{ text: null, status: 0 }` on timeout — caller decides the fallback path.
 */
export async function inferStringOnSomnia(
  req: InferStringRequest,
  opts: InferStringOpts
): Promise<InferStringResult> {
  const { publicClient, walletClient, chainId } = opts;
  const waitMs = opts.waitMs ?? 90_000;
  const gasPriceGwei = opts.gasPriceGwei ?? 10;
  const cfg = opts.llmConfig ?? getChainLlmConfig(chainId);

  const payload = encodeInferStringPayload({
    prompt: req.prompt,
    system: req.system ?? "",
    chainOfThought: req.chainOfThought ?? false,
    allowedValues: req.allowedValues ?? [],
  });

  const reserve = await publicClient.readContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "getRequestDeposit",
  });
  // Empirical: floor + 0.07 STT × 3 subcommittee members (see spike).
  const deposit = reserve + parseEther("0.07") * 3n;

  const start = Date.now();
  const txHash = await walletClient.writeContract({
    address: cfg.agentRequester,
    abi: REQUESTER_ABI,
    functionName: "createRequest",
    args: [cfg.agentId, cfg.store, HANDLE_RESPONSE_SELECTOR, payload],
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

  const outcome = await new Promise<{ text: string | null; status: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        unwatch();
        logger.warn(
          { requestId: requestId!.toString(), waitMs },
          "[agents/llm] ResultReady timeout — falling back"
        );
        resolve({ text: null, status: 0 });
      }, waitMs);
      const unwatch = publicClient.watchContractEvent({
        address: cfg.store,
        abi: STORE_ABI,
        eventName: "ResultReady",
        args: { requestId },
        onLogs: (logs) => {
          for (const log of logs) {
            const { status, text } = log.args as {
              status: number;
              text: string;
            };
            clearTimeout(timer);
            unwatch();
            // status enum: 0 = none/unknown, 1 = pending, 2 = success, others = error.
            resolve({ text: status === 2 ? text : null, status });
          }
        },
        onError: (e) => {
          clearTimeout(timer);
          unwatch();
          reject(e);
        },
      });
    }
  );

  return {
    text: outcome.text,
    status: outcome.status,
    requestId,
    txHash,
    latencySec: (Date.now() - start) / 1000,
  };
}

export function encodeInferStringPayload(args: {
  prompt: string;
  system: string;
  chainOfThought: boolean;
  allowedValues: string[];
}): Hex {
  const encoded = encodeAbiParameters(
    parseAbiParameters("string, string, bool, string[]"),
    [args.prompt, args.system, args.chainOfThought, args.allowedValues]
  );
  return (INFER_STRING_SELECTOR + encoded.slice(2)) as Hex;
}

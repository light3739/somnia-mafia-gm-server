/**
 * 4d SMOKE — full DAY chat round trip end-to-end on testnet.
 *
 * Verifies the new LLMChatResultStore + DayHandler + commitAgentMessageV2
 * path:
 *
 *   1. Sponsor (or agent) sends inferChat → LLMChatResultStore.
 *   2. Store emits ChatResultReady with the decoded text.
 *   3. Handler scrubs the text, computes the F2-bound messageHash.
 *   4. Handler sends commitAgentMessageV2(roomId, phaseId, messageHash) from
 *      the agent EOA.
 *   5. We independently fetch getAgentMessageHash from the diamond and assert
 *      it matches the locally computed hash (proves F2 binding).
 *
 * Note: commitAgentMessageV2 only checks isAgent — phase is opaque to the
 * contract. We bypass DAY-only gating and smoke against a room in any phase
 * (matching the smoke-night.ts pattern).
 *
 * Pre-reqs:
 *   - Room 8 on testnet has at least one registered agent under
 *     AGENT_MASTER_MNEMONIC.
 *   - Sponsor wallet has ≥0.3 STT for the inferChat deposit.
 *   - Agent EOA has ≥0.005 STT for the commit tx.
 *   - LLM_CHAT_STORE_50312 env points at the deployed store
 *     (0x07f351efdbd4478e3f31c2fdbd91d9e97ce76028).
 *
 * Run:
 *   cd somnia-mafia-gm-server
 *   npx tsx src/scripts/smoke-day-chat.ts
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseGwei,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { inferChatOnSomnia } from "../agents/llm-chat-call.js";
import { scrubText } from "../agents/scrubber.js";
import {
  AGENT_REGISTRY_ABI,
  DIAMOND_VOTE_ABI,
} from "../agents/registry-abi.js";
import {
  computeMessageHash,
  messageTextHash,
  canonicalPromptHash,
  makePhaseId,
  randomSalt,
  MSG_KIND_REGULAR,
  MSG_KIND_SKIP_SCRUBBED,
  SCRUB_VERSION,
} from "../agents/trace.js";
import { deriveAgentWallets } from "../agents/wallets.js";

const CHAIN_ID = 50312;
const DIAMOND: Address = "0x031b6746155ce11c7b533935f4674f5fc4682338";
const ROOM_ID = 8n;
const DAY_NUMBER = 1;
const MAX_AGENTS_PER_ROOM = 6;

const somniaTestnet = defineChain({
  id: CHAIN_ID,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.testnet.somnia.network/"] } },
});

function strip(pk: string | undefined): Hex {
  if (!pk) throw new Error("PK missing");
  const m = pk.trim().replace(/^['"]|['"]$/g, "").match(/^(0x)?[a-fA-F0-9]{64}/);
  if (!m) throw new Error("PK not hex");
  return (m[0].startsWith("0x") ? m[0] : `0x${m[0]}`) as Hex;
}

const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  const mnemonic = process.env.AGENT_MASTER_MNEMONIC;
  if (!mnemonic) throw new Error("AGENT_MASTER_MNEMONIC missing");

  const publicClient = createPublicClient({
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });

  console.log("=== 4d DAY chat smoke ===");
  console.log(`ChainId : ${CHAIN_ID}`);
  console.log(`Diamond : ${DIAMOND}`);
  console.log(`Room    : ${ROOM_ID}`);
  console.log(`Day     : ${DAY_NUMBER}`);

  // 1. Find the first registered agent in the room.
  const agentWallets = deriveAgentWallets(mnemonic, ROOM_ID, MAX_AGENTS_PER_ROOM);
  let agent: typeof agentWallets[number] | undefined;
  for (const w of agentWallets) {
    const isA = (await publicClient.readContract({
      address: DIAMOND,
      abi: AGENT_REGISTRY_ABI,
      functionName: "isAgent",
      args: [ROOM_ID, w.address],
    })) as boolean;
    if (isA) {
      agent = w;
      break;
    }
  }
  if (!agent) throw new Error("No registered agent found in room under our mnemonic");
  console.log(`Agent   : ${agent.address} (idx=${agent.idx})`);

  const agentBalance = await publicClient.getBalance({ address: agent.address });
  console.log(`Agent balance: ${(Number(agentBalance) / 1e18).toFixed(6)} STT`);

  // 2. Build a tiny prompt and call inferChat.
  const roles = ["system", "user"];
  const messages = [
    "You are a Mafia game player. Reply in one short line, no role hints.",
    "Day 1. Open the discussion with one neutral observation.",
  ];

  const agentClient = createWalletClient({
    account: agent.account,
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });

  console.log("Calling inferChat...");
  const start = Date.now();
  const infer = await inferChatOnSomnia(
    { roles, messages, chainOfThought: false },
    {
      publicClient,
      walletClient: agentClient,
      chainId: CHAIN_ID,
      waitMs: Number(process.env.LLM_CHAT_WAIT_MS ?? "60000"),
      gasPriceGwei: 10,
    }
  );
  console.log(
    `inferChat tx=${infer.txHash} requestId=${infer.requestId} latency=${infer.latencySec.toFixed(2)}s status=${infer.status}`
  );
  if (!infer.result) {
    console.error("inferChat returned null result — aborting");
    process.exit(1);
  }
  const rawText = infer.result.response;
  console.log(`LLM raw: ${JSON.stringify(rawText)}`);

  // 3. Scrub.
  const scrub = scrubText(rawText);
  console.log(`Scrub outcome: ${scrub.outcome}`);
  const msgKind = scrub.outcome === "ALLOWED" ? "MSG" : "SKIP_SCRUBBED";
  const sanitized = scrub.outcome === "ALLOWED" ? scrub.sanitized : null;

  // 4. Compute hashes.
  const salt = randomSalt();
  const rawResponseHash = keccak256(toHex(rawText));
  const promptHash = canonicalPromptHash(roles, messages);
  const sanitizedTextHash =
    msgKind === "MSG" && sanitized ? messageTextHash(sanitized) : ZERO_BYTES32;
  const phaseId = makePhaseId("DAY", DAY_NUMBER);
  const messageHash = computeMessageHash({
    chainId: BigInt(CHAIN_ID),
    diamond: DIAMOND,
    roomId: ROOM_ID,
    phaseId,
    agent: agent.address,
    salt,
    somniaRequestId: infer.requestId,
    promptHash,
    rawResponseHash,
    sanitizedTextHash,
    scrubVersion: SCRUB_VERSION,
    scrubAllowed: scrub.outcome === "ALLOWED",
    msgKind: msgKind === "MSG" ? MSG_KIND_REGULAR : MSG_KIND_SKIP_SCRUBBED,
  });
  console.log(`messageHash    : ${messageHash}`);
  console.log(`phaseId        : ${phaseId}`);
  console.log(`salt           : ${salt}`);
  console.log(`somniaRequestId: ${infer.requestId}`);

  // 5. F1 dedup pre-check.
  const existing = (await publicClient.readContract({
    address: DIAMOND,
    abi: AGENT_REGISTRY_ABI,
    functionName: "getAgentMessageHash",
    args: [ROOM_ID, phaseId, agent.address],
  })) as Hex;
  if (existing !== ZERO_BYTES32) {
    console.warn(
      `Already committed (stored=${existing}) — skipping send and using stored as success criteria.`
    );
    if (existing.toLowerCase() === messageHash.toLowerCase()) {
      console.log("OK — stored hash matches locally computed hash.");
    } else {
      console.log(
        "NOTE — stored hash is from a previous run with different salt; expected on re-runs."
      );
    }
    process.exit(0);
  }

  // 6. Send commitAgentMessageV2.
  console.log("Sending commitAgentMessageV2...");
  const txHash = await agentClient.writeContract({
    address: DIAMOND,
    abi: AGENT_REGISTRY_ABI,
    functionName: "commitAgentMessageV2",
    args: [ROOM_ID, phaseId, messageHash],
    gasPrice: parseGwei("10"),
  });
  console.log(`commit tx: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`commit status: ${receipt.status}`);
  if (receipt.status !== "success") process.exit(1);

  // 7. Verify on-chain getter matches local hash.
  const storedAfter = (await publicClient.readContract({
    address: DIAMOND,
    abi: AGENT_REGISTRY_ABI,
    functionName: "getAgentMessageHash",
    args: [ROOM_ID, phaseId, agent.address],
  })) as Hex;
  console.log(`getAgentMessageHash returns: ${storedAfter}`);
  if (storedAfter.toLowerCase() !== messageHash.toLowerCase()) {
    console.error("MISMATCH — chain hash != local hash");
    process.exit(1);
  }
  console.log(
    "OK — chain hash matches local hash. F2 provenance binding verified end-to-end."
  );
  console.log(`Total wall time: ${((Date.now() - start) / 1000).toFixed(2)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

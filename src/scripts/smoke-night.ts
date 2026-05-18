/**
 * 4f SMOKE — full NIGHT decision loop end-to-end on testnet.
 *
 * Verifies the new LLMToolsResultStore + decodeNightToolCall + commit-on-chain
 * path that the NightHandler will exercise in production:
 *
 *   1. Sponsor sends inferToolsChat → new LLMToolsResultStore (tools-aware sink).
 *   2. Store decodes the 6-tuple response, emits ToolsResultReady.
 *   3. We fetch the full StoredResult struct via getResult(requestId).
 *   4. We decode pendingToolCalls[0] → (kind, target) using decodeNightToolCall.
 *   5. Agent EOA sends commitAgentInference(roomId, D2-NIGHT phaseId, actionHash, traceCommitment).
 *   6. AgentInferenceCommitted event is verified in the receipt.
 *
 * The reason commitAgentInference does NOT require the room to be in the NIGHT
 * phase is that AgentRegistryFacet only checks isAgent[roomId][agent] (see
 * contracts/facets/AgentRegistryFacet.sol). phaseId is opaque to the contract —
 * we just standardise it via trace.makePhaseId. This means we can smoke against
 * a room still in LOBBY without driving the whole game state machine.
 *
 * Pre-reqs (per memory live-smoke-4g, 2026-05-17):
 *   - Room 8 on testnet has at least one registered agent under our mnemonic.
 *   - Sponsor wallet (0x3D9297) has ≥0.3 STT for the inferToolsChat deposit.
 *   - Agent EOA has ≥0.005 STT for the commit tx (top-up'd by fill-room flow).
 *
 * Run:
 *   cd somnia-mafia-gm-server
 *   npx tsx src/scripts/smoke-night.ts
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  http,
  parseAbi,
  parseGwei,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  inferToolsChatOnSomnia,
} from "../agents/llm-tools-call.js";
import {
  buildNightPrompt,
  decodeNightToolCall,
} from "../agents/night.js";
import { AgentRole, roleLabel } from "../agents/roles.js";
import {
  AGENT_REGISTRY_ABI,
  DIAMOND_VOTE_ABI,
  nightActionHash,
} from "../agents/registry-abi.js";
import {
  computeTraceCommitment,
  makePhaseId,
  randomSalt,
} from "../agents/trace.js";
import { deriveAgentWallets } from "../agents/wallets.js";

const CHAIN_ID = 50312;
const DIAMOND: Address = "0x031b6746155ce11c7b533935f4674f5fc4682338";
const ROOM_ID = 8n;
const DAY_COUNT = 2;
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

async function main() {
  const mnemonic = process.env.AGENT_MASTER_MNEMONIC;
  if (!mnemonic) throw new Error("AGENT_MASTER_MNEMONIC missing");
  const sponsorKey = strip(process.env.AGENT_SPONSOR_PRIVATE_KEY);
  const sponsor = privateKeyToAccount(sponsorKey);

  const publicClient = createPublicClient({
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });
  const sponsorClient = createWalletClient({
    account: sponsor,
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });

  console.log("=== 4f NIGHT smoke ===");
  console.log(`ChainId  : ${CHAIN_ID}`);
  console.log(`Diamond  : ${DIAMOND}`);
  console.log(`Room     : ${ROOM_ID}`);
  console.log(`Sponsor  : ${sponsor.address}`);

  // Find a registered agent in room 8 that we can derive from our mnemonic.
  const candidates = deriveAgentWallets(mnemonic, ROOM_ID, MAX_AGENTS_PER_ROOM);
  console.log(`\nCandidate agents (HD-derived for room ${ROOM_ID}):`);
  let registeredAgent: (typeof candidates)[number] | null = null;
  for (const w of candidates) {
    const isAgent = (await publicClient.readContract({
      address: DIAMOND,
      abi: AGENT_REGISTRY_ABI,
      functionName: "isAgent",
      args: [ROOM_ID, w.address],
    })) as boolean;
    console.log(`  [${w.idx}] ${w.address}  isAgent=${isAgent}`);
    if (isAgent && !registeredAgent) registeredAgent = w;
  }
  if (!registeredAgent) {
    throw new Error(
      `No HD-derived agent for room ${ROOM_ID} is registered on chain. Run /agents/fill-room first.`
    );
  }
  console.log(
    `\nUsing agent [${registeredAgent.idx}] ${registeredAgent.address}`
  );

  const agentClient = createWalletClient({
    account: registeredAgent.account,
    chain: somniaTestnet,
    transport: http(somniaTestnet.rpcUrls.default.http[0]),
  });

  // Pull current room alive set for prompt context (informational only — the
  // smoke does not care if the room is in NIGHT phase, since commitAgentInference
  // is phase-agnostic).
  const room: any = await publicClient.readContract({
    address: DIAMOND,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getRoom",
    args: [ROOM_ID],
  });
  const players: any = await publicClient.readContract({
    address: DIAMOND,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getPlayers",
    args: [ROOM_ID],
  });
  const alive: Address[] = players
    .filter((p: any) => (Number(p.flags) & 0x2) !== 0)
    .map((p: any) => p.wallet as Address);
  console.log(`Room phase=${room.phase} dayCount=${room.dayCount} alive=${alive.length}`);
  console.log(`Alive: ${alive.join(", ")}`);

  if (alive.length < 2) {
    throw new Error(
      `Room ${ROOM_ID} only has ${alive.length} alive player(s) — need at least 2 for a valid night decision target.`
    );
  }

  // Balances pre-flight.
  const sponsorBalBefore = await publicClient.getBalance({
    address: sponsor.address,
  });
  const agentBalBefore = await publicClient.getBalance({
    address: registeredAgent.address,
  });
  console.log(
    `\nBalances: sponsor=${formatEther(sponsorBalBefore)} STT, agent=${formatEther(agentBalBefore)} STT`
  );

  // Check the D2-NIGHT slot is not already committed for this agent.
  const phaseIdHex = makePhaseId("NIGHT", DAY_COUNT);
  const existing = (await publicClient.readContract({
    address: DIAMOND,
    abi: AGENT_REGISTRY_ABI,
    functionName: "getAgentTraceCommitment",
    args: [ROOM_ID, phaseIdHex, registeredAgent.address],
  })) as Hex;
  if (
    existing !==
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    throw new Error(
      `Slot already committed: room=${ROOM_ID} phase=D${DAY_COUNT}-NIGHT agent=${registeredAgent.address} commitment=${existing}\n` +
      `Pick a different DAY_COUNT (e.g. 3) and rerun.`
    );
  }

  // Build mafia prompt + fire inferToolsChat from sponsor.
  const role = AgentRole.MAFIA;
  const { roles, messages, tools } = buildNightPrompt({
    self: registeredAgent.address,
    role,
    alive,
    dayCount: DAY_COUNT,
    language: "English",
  });

  console.log(`\n→ inferToolsChat (role=${roleLabel(role)})...`);
  const inferStart = Date.now();
  const infer = await inferToolsChatOnSomnia(
    {
      roles,
      messages,
      mcpServerUrls: [],
      onchainTools: tools,
      maxIterations: 1,
      chainOfThought: false,
    },
    {
      publicClient,
      walletClient: sponsorClient,
      chainId: CHAIN_ID,
      waitMs: 120_000,
      gasPriceGwei: 10,
    }
  );
  const inferSec = ((Date.now() - inferStart) / 1000).toFixed(1);
  console.log(`  tx       : ${infer.txHash}`);
  console.log(`  requestId: ${infer.requestId}`);
  console.log(`  status   : ${infer.status}`);
  console.log(`  latency  : ${inferSec}s`);

  if (!infer.result) {
    throw new Error(
      `inferToolsChat returned null result (status=${infer.status}). The new LLMToolsResultStore did not decode the 6-tuple — debug.`
    );
  }
  console.log(`  finish   : ${infer.result.finishReason}`);
  console.log(`  response : "${infer.result.response.slice(0, 80)}"`);
  console.log(`  toolCalls: ${infer.result.pendingToolCalls.length}`);
  for (let i = 0; i < infer.result.pendingToolCalls.length; i++) {
    console.log(
      `    [${i}] id=${infer.result.pendingToolCallIds[i]} calldata=${infer.result.pendingToolCalls[i].slice(0, 50)}...`
    );
  }

  const firstCalldata =
    infer.result.pendingToolCalls.length > 0
      ? infer.result.pendingToolCalls[0]
      : null;
  const decision = decodeNightToolCall(
    firstCalldata,
    role,
    registeredAgent.address,
    alive
  );
  console.log(
    `\nDecision: kind=${decision.kind} target=${decision.target} source=${decision.source}${decision.fallbackReason ? ` (${decision.fallbackReason})` : ""}`
  );

  // Build trace material and commit.
  const salt = randomSalt();
  const promptText = `${roles[0]}: ${messages[0]}\n${roles[1]}: ${messages[1]}`;
  const { keccak256, toHex } = await import("viem");
  const promptHash = keccak256(toHex(promptText));
  const responseHash = keccak256(
    toHex(firstCalldata ?? infer.result.response ?? "")
  );
  const actionHash = nightActionHash(decision.kind, decision.target);
  const traceCommitment = computeTraceCommitment({
    diamond: DIAMOND,
    chainId: BigInt(CHAIN_ID),
    roomId: ROOM_ID,
    phaseId: phaseIdHex,
    agent: registeredAgent.address,
    salt,
    somniaRequestId: infer.requestId,
    promptHash,
    responseHash,
    actionHash,
  });

  console.log(`\n→ commitAgentInference (agent EOA)...`);
  console.log(`  phaseId        : ${phaseIdHex}`);
  console.log(`  actionHash     : ${actionHash}`);
  console.log(`  traceCommitment: ${traceCommitment}`);

  const commitTx = await agentClient.writeContract({
    address: DIAMOND,
    abi: AGENT_REGISTRY_ABI,
    functionName: "commitAgentInference",
    args: [ROOM_ID, phaseIdHex, actionHash, traceCommitment],
    gasPrice: parseGwei("10"),
  });
  console.log(`  tx: ${commitTx}`);
  console.log(`  explorer: https://shannon-explorer.somnia.network/tx/${commitTx}`);

  const commitReceipt = await publicClient.waitForTransactionReceipt({
    hash: commitTx,
  });
  console.log(
    `  receipt: status=${commitReceipt.status} block=${commitReceipt.blockNumber}`
  );
  if (commitReceipt.status !== "success") {
    throw new Error(`commit tx reverted (${commitTx})`);
  }

  // Verify the AgentInferenceCommitted event matches.
  let committedEvent: any | null = null;
  for (const log of commitReceipt.logs) {
    if (log.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
    try {
      const d = decodeEventLog({
        abi: AGENT_REGISTRY_ABI,
        topics: log.topics,
        data: log.data,
      });
      if (d.eventName === "AgentInferenceCommitted") {
        committedEvent = d.args;
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (!committedEvent) {
    throw new Error("AgentInferenceCommitted event not found in receipt");
  }
  if (committedEvent.actionHash !== actionHash) {
    throw new Error(
      `actionHash mismatch: event=${committedEvent.actionHash} expected=${actionHash}`
    );
  }
  if (committedEvent.traceCommitment !== traceCommitment) {
    throw new Error(
      `traceCommitment mismatch: event=${committedEvent.traceCommitment} expected=${traceCommitment}`
    );
  }
  console.log(`\n✅ AgentInferenceCommitted event matches expected actionHash + traceCommitment`);

  const sponsorBalAfter = await publicClient.getBalance({
    address: sponsor.address,
  });
  const agentBalAfter = await publicClient.getBalance({
    address: registeredAgent.address,
  });
  console.log(
    `\nFinal balances: sponsor=${formatEther(sponsorBalAfter)} STT (Δ=${formatEther(sponsorBalBefore - sponsorBalAfter)}), agent=${formatEther(agentBalAfter)} STT (Δ=${formatEther(agentBalBefore - agentBalAfter)})`
  );
  console.log(`\nDone.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

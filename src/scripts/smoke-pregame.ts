/**
 * 4j SMOKE — autonomous all-agent pre-game end-to-end on testnet.
 *
 * Proves the whole 4j chain LIVE against the real Diamond:
 *
 *   1. Predict the next roomId (LobbyFacet.nextRoomId + 1) — needed because the
 *      host must be an HD-derived agent for THAT roomId, but createAndJoin only
 *      assigns the id at call time (roomId = ++nextRoomId). We derive for the
 *      predicted id, create, then assert the on-chain host matches (guards the
 *      tiny race where someone else creates a room between our read and write).
 *   2. Host agent (idx 0) createAndJoin → becomes host + player 0.
 *   3. GM registerAgent(host) — fillRoomWithAgents only registers the agents IT
 *      joins, so the host needs registering separately.
 *   4. fillRoomWithAgents(agentCount-1) → joins + registers agents idx 1..N-1.
 *   5. Host agent startGame → GameStarted → SHUFFLING.
 *   6. Drive PreGameHandler.handleShuffling + handleReveal IN PROCESS (the most
 *      direct proof of the handler — no dependency on the live event listener).
 *   7. Assert the room reached DAY, every agent confirmed a role, and the role
 *      distribution matches the contract's mafiaCount rule.
 *
 * This is the real proof that an all-agent game now reaches DAY (4i unblocked),
 * AND it resolves the "who is host / who calls startGame" open question by making
 * an agent the host.
 *
 * Pre-reqs:
 *   - .env with AGENT_MASTER_MNEMONIC, AGENT_SPONSOR_PRIVATE_KEY (funded),
 *     GM_PRIVATE_KEY, REDIS_URL, and the chain config the gm-server uses.
 *   - Sponsor funded GENEROUSLY — pre-game gas is heavy (revealDeck ~14.5M each)
 *     and every agent does commit+reveal (+ host: create+start). Budget a few STT
 *     per agent. Override the per-agent reserve with SMOKE_GAS_RESERVE_STT.
 *
 * Run:
 *   cd somnia-mafia-gm-server
 *   SMOKE_AGENT_COUNT=4 npx tsx src/scripts/smoke-pregame.ts
 */
import "dotenv/config";
import {
  createWalletClient,
  http,
  parseEther,
  parseGwei,
  formatEther,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { connectRedis, getRedis } from "../redis.js";
import { getChainConfig } from "../chain.js";
import { deriveAgentWallet } from "../agents/wallets.js";
import { ensureAgentEciesKeypair } from "../agents/ecies-keys.js";
import { topUp, getSponsorAddress, getSponsorBalance } from "../agents/sponsor.js";
import {
  fillRoomWithAgents,
  POLICY_HASH,
  MODEL_HASH,
  META_HASH,
} from "../agents/fill-room.js";
import { makePreGameChainOps } from "../agents/chain-ops.js";
import { PreGameHandler } from "../agents/pregame.js";
import {
  AGENT_REGISTRY_ABI,
  AGENT_REGISTRY_WRITE_ABI,
  DIAMOND_VOTE_ABI,
} from "../agents/registry-abi.js";
import { getAgentRole, roleLabel } from "../agents/roles.js";

const CHAIN_ID = Number(process.env.SMOKE_CHAIN_ID ?? "50312");
const AGENT_COUNT = Number(process.env.SMOKE_AGENT_COUNT ?? "4"); // ≥4 (startGame min)
const GAS = Number(process.env.TX_GAS_PRICE_GWEI ?? "10");
const GAS_RESERVE = parseEther(process.env.SMOKE_GAS_RESERVE_STT ?? "2");
// SMOKE_DRIVE=false → bootstrap + startGame only, then poll while a separately
// running gm-server (AGENTS_ENABLED=true) drives the pre-game via its listener.
// Proves the event-driven path end-to-end on chain.
const DRIVE = (process.env.SMOKE_DRIVE ?? "true").toLowerCase() !== "false";
const PHASE_DAY = 3;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const LOBBY_EXTRA_ABI = parseAbi([
  "function createAndJoin(string roomName, uint8 maxPlayers, string nickname, bytes publicKey, address sessionAddress, bool isPrivate, uint256 tournamentId) payable returns (uint256)",
  "function nextRoomId() view returns (uint256)",
  "function getEntryFee() view returns (uint128)",
  "function getDefaultDeposit() view returns (uint128)",
]);

function explorer(hash: string): string {
  return `https://shannon-explorer.somnia.network/tx/${hash}`;
}

/** Expected role distribution for `alive` players (mirrors generateDistributedDeck). */
function expectedCounts(alive: number) {
  const mafia = alive <= 5 ? 1 : alive <= 8 ? 2 : alive <= 11 ? 3 : 4;
  const doctor = alive >= 4 ? 1 : 0;
  const detective = alive >= 5 ? 1 : 0;
  return { mafia, doctor, detective, citizen: alive - mafia - doctor - detective };
}

async function main() {
  if (AGENT_COUNT < 4) throw new Error("SMOKE_AGENT_COUNT must be ≥4 (startGame requires ≥4 players)");
  const mnemonic = process.env.AGENT_MASTER_MNEMONIC;
  if (!mnemonic) throw new Error("AGENT_MASTER_MNEMONIC missing");

  await connectRedis();
  const redis = getRedis();
  if (!redis) throw new Error("Redis not connected");

  const { public: publicClient, wallet: gmWallet, diamond } = getChainConfig(CHAIN_ID);
  const chainObj = publicClient.chain as Chain;

  console.log("=== 4j PRE-GAME smoke (autonomous all-agent) ===");
  console.log(`ChainId : ${CHAIN_ID}`);
  console.log(`Diamond : ${diamond}`);
  console.log(`Agents  : ${AGENT_COUNT}`);
  console.log(`Sponsor : ${getSponsorAddress()} (${formatEther(await getSponsorBalance(CHAIN_ID))} STT)`);

  // 1. Predict roomId — host must be HD-derived for it before it exists.
  const nextId = (await publicClient.readContract({
    address: diamond,
    abi: LOBBY_EXTRA_ABI,
    functionName: "nextRoomId",
  })) as bigint;
  const roomId = nextId + 1n;
  const roomIdStr = roomId.toString();
  console.log(`\nPredicted roomId: ${roomId}`);

  const entryFee = (await publicClient.readContract({
    address: diamond,
    abi: LOBBY_EXTRA_ABI,
    functionName: "getEntryFee",
  })) as bigint;
  const deposit = (await publicClient.readContract({
    address: diamond,
    abi: LOBBY_EXTRA_ABI,
    functionName: "getDefaultDeposit",
  })) as bigint;
  const joinValue = entryFee + deposit;
  const perAgentFunding = joinValue + GAS_RESERVE;
  console.log(
    `entryFee=${formatEther(entryFee)} deposit=${formatEther(deposit)} gasReserve=${formatEther(GAS_RESERVE)} → perAgent=${formatEther(perAgentFunding)} STT`
  );

  // 2. Host agent (idx 0) creates + joins the room.
  const host = deriveAgentWallet({ mnemonic, roomId, idx: 0 });
  console.log(`\nHost agent [0]: ${host.address}`);
  await topUp(CHAIN_ID, host.address, perAgentFunding, { waitForReceipt: true });
  const hostKp = await ensureAgentEciesKeypair(redis, CHAIN_ID, roomIdStr, host.address);
  const hostWallet = createWalletClient({
    account: host.account,
    chain: chainObj,
    transport: http(chainObj.rpcUrls.default.http[0]),
  });

  console.log("→ createAndJoin (host)...");
  const createTx = await hostWallet.writeContract({
    address: diamond,
    abi: LOBBY_EXTRA_ABI,
    functionName: "createAndJoin",
    args: [
      `agents-${roomId}`.slice(0, 32),
      AGENT_COUNT,
      "Agent #1",
      (`0x${hostKp.pubHex}`) as Hex,
      ZERO,
      false, // public room — joiners need no GM signature
      0n,
    ],
    value: joinValue,
    gasPrice: parseGwei(String(GAS)),
    chain: null,
  } as any);
  await publicClient.waitForTransactionReceipt({ hash: createTx });
  console.log(`  tx: ${explorer(createTx)}`);

  // Assert the predicted id materialised and we are the host (race guard).
  const created: any = await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getRoom",
    args: [roomId],
  });
  if (created.host.toLowerCase() !== host.address.toLowerCase()) {
    throw new Error(
      `roomId prediction lost a race: room ${roomId} host=${created.host} (expected ${host.address}). Re-run.`
    );
  }
  console.log(`  room ${roomId} created, host=${created.host}, phase=${created.phase}`);

  // 3. Register the host as an agent (fill-room only registers who it joins).
  console.log("→ registerAgent (host)...");
  const regTx = (await (gmWallet as any).writeContract({
    address: diamond,
    abi: AGENT_REGISTRY_WRITE_ABI,
    functionName: "registerAgent",
    args: [roomId, host.address, POLICY_HASH, MODEL_HASH, META_HASH],
    gasPrice: parseGwei(String(GAS)),
    chain: null,
  })) as Hex;
  await publicClient.waitForTransactionReceipt({ hash: regTx });
  console.log(`  tx: ${explorer(regTx)}`);

  // 4. Fill the remaining seats with agents (joins + registers idx 1..N-1).
  console.log(`\n→ fillRoomWithAgents (${AGENT_COUNT - 1} more)...`);
  const fill = await fillRoomWithAgents(
    { chainId: CHAIN_ID, roomId, agentCount: AGENT_COUNT - 1, perAgentFundingWei: perAgentFunding },
    { redis }
  );
  for (const o of fill.outcomes) console.log(`  [${o.idx}] ${o.agent} → ${o.status}`);
  const filledOk = fill.outcomes.filter((o) => o.status === "filled" || o.status === "skipped-already-in-room").length;
  if (filledOk < AGENT_COUNT - 1) {
    throw new Error(`fill-room incomplete: only ${filledOk}/${AGENT_COUNT - 1} seats filled`);
  }

  // Verify the room is full and every player is a registered agent.
  const players: any[] = (await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getPlayers",
    args: [roomId],
  })) as any[];
  console.log(`\nRoom now has ${players.length} players:`);
  for (const p of players) {
    const isAgent = (await publicClient.readContract({
      address: diamond,
      abi: AGENT_REGISTRY_ABI,
      functionName: "isAgent",
      args: [roomId, p.wallet],
    })) as boolean;
    console.log(`  ${p.wallet} isAgent=${isAgent}`);
    if (!isAgent) throw new Error(`player ${p.wallet} is not a registered agent — all-agent invariant broken`);
  }
  if (players.length < 4) throw new Error(`room has ${players.length} players, need ≥4`);

  // 5. Host starts the game.
  const ops = makePreGameChainOps(CHAIN_ID);
  console.log("\n→ startGame (host)...");
  const startTx = await ops.sendStartGame(host.account, roomId, GAS);
  console.log(`  tx: ${explorer(startTx)}`);

  // 6. Drive the pre-game — in process, OR let the running server's listener.
  if (DRIVE) {
    const handler = new PreGameHandler({
      redis,
      chainOpsFor: () => ops,
      mnemonic,
      txGasPriceGwei: GAS,
      maxAgentsPerRoom: AGENT_COUNT,
      shareKeysOnChain: (process.env.AGENTS_SHARE_KEYS_ONCHAIN ?? "").toLowerCase() === "true",
    });

    console.log("\n→ handleShuffling (in-process)...");
    const shuffleOutcomes = await handler.handleShuffling({ chainId: CHAIN_ID, roomId: roomIdStr });
    for (const o of shuffleOutcomes) console.log(`  ${o.agent} → ${o.status}${o.err ? ` (${o.err})` : ""}`);

    console.log("→ handleReveal (in-process)...");
    const revealOutcomes = await handler.handleReveal({ chainId: CHAIN_ID, roomId: roomIdStr });
    for (const o of revealOutcomes) {
      console.log(`  ${o.agent} → ${o.status} role=${o.roleId ? roleLabel(o.roleId as any) : "-"}`);
    }
  } else {
    console.log("\nSMOKE_DRIVE=false → the running gm-server's listener drives. Polling for DAY...");
    const deadline = Date.now() + Number(process.env.SMOKE_POLL_MS ?? "240000");
    while (Date.now() < deadline) {
      const r: any = await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_VOTE_ABI,
        functionName: "getRoom",
        args: [roomId],
      });
      console.log(
        `  phase=${r.phase} shufflerIdx=${r.currentShufflerIndex} revealed=${r.revealedCount} confirmed=${r.confirmedCount}/${r.aliveCount}`
      );
      if (Number(r.phase) === PHASE_DAY) break;
      await new Promise((res) => setTimeout(res, 6000));
    }
  }

  // 7. Verify: reached DAY, all confirmed, distribution correct.
  const finalRoom: any = await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getRoom",
    args: [roomId],
  });
  console.log(
    `\nFinal: phase=${finalRoom.phase} confirmedCount=${finalRoom.confirmedCount}/${finalRoom.aliveCount} dayCount=${finalRoom.dayCount}`
  );

  if (Number(finalRoom.phase) !== PHASE_DAY) {
    throw new Error(`room did NOT reach DAY (phase=${finalRoom.phase}). Pre-game failed.`);
  }

  // Role distribution from the agent keyspace (resolved server-direct).
  const counts: Record<string, number> = { Mafia: 0, Doctor: 0, Detective: 0, Citizen: 0, Unknown: 0 };
  for (const p of players) {
    const role = await getAgentRole(redis, CHAIN_ID, roomIdStr, p.wallet);
    counts[roleLabel(role)] = (counts[roleLabel(role)] ?? 0) + 1;
  }
  const exp = expectedCounts(players.length);
  console.log(`Roles resolved: ${JSON.stringify(counts)}`);
  console.log(`Expected      : ${JSON.stringify({ Mafia: exp.mafia, Doctor: exp.doctor, Detective: exp.detective, Citizen: exp.citizen })}`);
  const distOk =
    counts.Mafia === exp.mafia &&
    counts.Doctor === exp.doctor &&
    counts.Detective === exp.detective &&
    counts.Citizen === exp.citizen;
  if (!distOk) throw new Error("role distribution mismatch — resolution bug");

  console.log(`\n✅ All-agent room ${roomId} reached DAY with correct role distribution. 4i unblocked.`);
  void ZERO32;
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

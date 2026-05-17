/**
 * agents/fill-room.ts — Provision N autonomous agents into a Mafia room.
 *
 * One operator HTTP call (the 4g endpoint at routes/agentRoutes.ts) hands this
 * module a roomId and a desired agent count. The module:
 *
 *   Phase 0 — preflight:
 *     - reads the room (must be in LOBBY, must have room.maxPlayers - playersCount ≥ agentCount)
 *     - derives N HD agent wallets from AGENT_MASTER_MNEMONIC at a starting
 *       index based on the current playersCount (so re-runs after partial
 *       failure skip slots already filled by prior agents).
 *     - computes per-agent funding need = entryFee + depositPerPlayer + gasReserve
 *     - reads the sponsor balance, errors out if total > balance.
 *
 *   Phase 1 — sponsor top-up (sequential, single sponsor wallet/nonce):
 *     for each agent: sponsor.topUp(agentAddress, fundingPerAgent).
 *
 *   Phase 2 — agent joinRoom (parallel, each agent has its own nonce stream):
 *     for each agent: generate ECIES keypair → joinRoom from agent EOA
 *     (sessionAddress=zero so no session-key plumbing; gmSignature provided
 *     unconditionally so both public and private rooms accept the tx).
 *
 *   Phase 3 — GM registerAgent (sequential, single GM wallet/nonce):
 *     for each successfully-joined agent: GM.registerAgent(roomId, agent, ...).
 *
 * Idempotency: per-(chainId, roomId, agent) action key in Redis. If a slot
 * has already been processed by a prior fill-room call, that agent is
 * skipped (its on-chain state is the source of truth — we re-check via
 * isPlayerInRoom + isAgent).
 *
 * Failure model: each phase is best-effort per-agent. We return a result
 * envelope summarising every agent's outcome. Operator can re-call to retry
 * failures; idempotency keys + on-chain state make re-runs safe.
 */
import {
  keccak256,
  toBytes,
  toHex,
  parseEther,
  parseGwei,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type HDAccount,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Redis } from "ioredis";
import { logger } from "../utils/logger.js";
import { getChainConfig, signJoinPermit } from "../chain.js";
import {
  AGENT_REGISTRY_WRITE_ABI,
  DIAMOND_LOBBY_ABI,
  DIAMOND_VOTE_ABI,
} from "./registry-abi.js";
import {
  deriveAgentWallet,
  loadOrGenerateMnemonic,
  type AgentWallet,
} from "./wallets.js";
import { ensureAgentEciesKeypair } from "./ecies-keys.js";
import { topUp, getSponsorAddress, getSponsorBalance } from "./sponsor.js";
import { agentActionProcessedKey, IDEMPOTENCY_TTL_SECONDS } from "./redis-keys.js";

const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";
const PHASE_LOBBY = 0;

/** Per-agent gas reserve in wei. Override via AGENT_GAS_RESERVE_WEI. Default 0.5 STT. */
function defaultGasReserve(): bigint {
  const raw = process.env.AGENT_GAS_RESERVE_WEI;
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      logger.warn(
        { raw },
        "[agents/fill] AGENT_GAS_RESERVE_WEI not parseable as bigint — falling back to default"
      );
    }
  }
  return parseEther("0.5");
}

export interface FillRoomRequest {
  chainId: number;
  roomId: bigint;
  agentCount: number;
  nicknamePrefix?: string;
  /** Override per-agent funding amount (in wei). Defaults to entryFee + deposit + gasReserve. */
  perAgentFundingWei?: bigint;
}

export type AgentFillOutcome =
  | {
      status: "filled";
      idx: number;
      agent: Address;
      topUpTxHash: Hex;
      joinTxHash: Hex;
      registerTxHash: Hex;
      eciesPubHex: string;
    }
  | {
      status: "skipped-already-in-room";
      idx: number;
      agent: Address;
    }
  | {
      status: "topup-failed" | "join-failed" | "register-failed";
      idx: number;
      agent: Address;
      err: string;
      topUpTxHash?: Hex;
      joinTxHash?: Hex;
    };

export interface FillRoomResult {
  roomId: string;
  chainId: number;
  sponsor: Address;
  outcomes: AgentFillOutcome[];
}

/**
 * Chain access surface used by the orchestrator. Production builds this from
 * src/chain.ts + viem; tests inject a fake so no fetch ever fires.
 */
export interface FillChainAccess {
  publicClient: PublicClient;
  /** GM wallet client (used to call registerAgent). */
  gmWalletClient: WalletClient;
  diamond: Address;
  /** Build a wallet client for a given agent account (drives joinRoom). */
  buildAgentWalletClient(agent: HDAccount): WalletClient;
}

export interface FillRoomDeps {
  redis: Redis;
  /** Override mnemonic loader for tests. Production uses env AGENT_MASTER_MNEMONIC. */
  loadMnemonic?: () => string;
  /** Override chain access for tests. Production builds from src/chain.ts. */
  chainAccessOverride?: FillChainAccess;
}

function defaultChainAccess(chainId: number): FillChainAccess {
  const { public: publicClient, wallet: gmWalletClient, diamond } = getChainConfig(chainId);
  const chainObj = publicClient.chain as Chain | undefined;
  if (!chainObj) throw new Error(`chain ${chainId} has no .chain on publicClient`);
  const rpcUrl = chainObj.rpcUrls.default.http[0];
  return {
    publicClient,
    gmWalletClient,
    diamond,
    buildAgentWalletClient(agent) {
      return createWalletClient({
        account: agent,
        chain: chainObj,
        transport: http(rpcUrl),
      });
    },
  };
}

/** Hashes for the manifest — stable strings so post-game audit can recompute. */
const POLICY_HASH = keccak256(toBytes("MAFIA_AGENT_POLICY_V1"));
const MODEL_HASH = keccak256(toBytes("somnia-llm-12847293847561029384"));
const META_HASH = keccak256(
  toBytes(JSON.stringify({ version: "1.0.0", flow: "Pattern-B-2tx" }))
);

export async function fillRoomWithAgents(
  req: FillRoomRequest,
  deps: FillRoomDeps
): Promise<FillRoomResult> {
  const { chainId, roomId, agentCount } = req;
  if (agentCount < 1 || agentCount > 6) {
    throw new Error(`agentCount out of range [1, 6]: ${agentCount}`);
  }

  const mnemonic = (deps.loadMnemonic ?? loadOrGenerateMnemonic)();
  const sponsorAddr = getSponsorAddress();
  const log = logger.child({
    mod: "agents/fill",
    chainId,
    roomId: roomId.toString(),
    sponsor: sponsorAddr,
  });

  // ── Phase 0: preflight ──────────────────────────────────────────────
  const chainAccess = deps.chainAccessOverride ?? defaultChainAccess(chainId);
  const { publicClient, gmWalletClient, diamond } = chainAccess;

  const room: any = await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getRoom",
    args: [roomId],
  });
  if (Number(room.phase) !== PHASE_LOBBY) {
    throw new Error(
      `room ${roomId} not in LOBBY phase (got phase ${room.phase})`
    );
  }
  const playersCount = Number(room.playersCount);
  const maxPlayers = Number(room.maxPlayers);
  if (playersCount + agentCount > maxPlayers) {
    throw new Error(
      `room ${roomId} can fit only ${maxPlayers - playersCount} more agent(s), requested ${agentCount}`
    );
  }

  const entryFee = (await publicClient
    .readContract({
      address: diamond,
      abi: DIAMOND_LOBBY_ABI,
      functionName: "getEntryFee",
    })
    .catch((err: any) => {
      log.warn({ err }, "[agents/fill] getEntryFee failed — assuming 0");
      return 0n as unknown as bigint;
    })) as bigint;
  const depositPerPlayer = BigInt(room.depositPerPlayer);
  const gasReserve = defaultGasReserve();
  const perAgentFunding =
    req.perAgentFundingWei ?? entryFee + depositPerPlayer + gasReserve;

  log.info(
    {
      entryFee: entryFee.toString(),
      depositPerPlayer: depositPerPlayer.toString(),
      gasReserve: gasReserve.toString(),
      perAgentFunding: perAgentFunding.toString(),
      agentCount,
    },
    "[agents/fill] preflight"
  );

  const sponsorBalance = await getSponsorBalance(chainId);
  const totalNeeded = perAgentFunding * BigInt(agentCount);
  if (sponsorBalance < totalNeeded) {
    throw new Error(
      `sponsor balance ${sponsorBalance} wei < required ${totalNeeded} wei for ${agentCount} agents`
    );
  }

  // ── Derive wallets. Start index = playersCount so re-runs after partial
  // failures skip slots already filled. (HD path is bucketed per-room so
  // collisions between roomA and roomB are not an issue.)
  const wallets: AgentWallet[] = Array.from({ length: agentCount }, (_, i) =>
    deriveAgentWallet({ mnemonic, roomId, idx: playersCount + i })
  );
  log.info(
    { agents: wallets.map((w) => `${w.idx}:${w.address}`) },
    "[agents/fill] derived agent wallets"
  );

  // ── Skip wallets already in the room (idempotency on partial-run state).
  const existingPlayers: any = await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_VOTE_ABI,
    functionName: "getPlayers",
    args: [roomId],
  });
  const inRoom = new Set<string>(
    (existingPlayers as { wallet: Address }[]).map((p) => p.wallet.toLowerCase())
  );

  const outcomes: AgentFillOutcome[] = [];
  const todo: AgentWallet[] = [];
  for (const w of wallets) {
    if (inRoom.has(w.address.toLowerCase())) {
      outcomes.push({
        status: "skipped-already-in-room",
        idx: w.idx,
        agent: w.address,
      });
      continue;
    }
    todo.push(w);
  }

  if (todo.length === 0) {
    log.info("[agents/fill] all candidate agents already in room");
    return { roomId: roomId.toString(), chainId, sponsor: sponsorAddr, outcomes };
  }

  // ── Phase 1: sequential sponsor top-ups ─────────────────────────────
  // Skip top-up if the agent already holds at least `perAgentFunding` — handles
  // the partial-failure retry case (prior run topped up but never joined).
  const topUpHashes = new Map<string, Hex>();
  const PRE_FUNDED_MARK = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  for (const w of todo) {
    try {
      const existing = await publicClient.getBalance({ address: w.address });
      if (existing >= perAgentFunding) {
        log.info(
          { agent: w.address, existing: existing.toString() },
          "[agents/fill] agent already funded — skipping top-up"
        );
        topUpHashes.set(w.address.toLowerCase(), PRE_FUNDED_MARK);
        continue;
      }
      const hash = await topUp(chainId, w.address, perAgentFunding - existing, {
        waitForReceipt: true,
      });
      topUpHashes.set(w.address.toLowerCase(), hash);
      log.info({ agent: w.address, hash }, "[agents/fill] sponsor top-up ok");
    } catch (err: any) {
      outcomes.push({
        status: "topup-failed",
        idx: w.idx,
        agent: w.address,
        err: String(err?.message ?? err),
      });
      log.error(
        { agent: w.address, err: String(err?.message ?? err) },
        "[agents/fill] top-up failed"
      );
    }
  }

  const funded = todo.filter((w) => topUpHashes.has(w.address.toLowerCase()));

  // ── Phase 2: parallel agent joinRoom ────────────────────────────────
  const joinHashes = new Map<string, Hex>();
  const joinErrors = new Map<string, string>();
  const eciesPubByAgent = new Map<string, string>();

  await Promise.all(
    funded.map(async (w) => {
      try {
        const actionKey = agentActionProcessedKey(
          chainId,
          roomId.toString(),
          "LOBBY-JOIN",
          w.address,
          "join"
        );
        const claimed = await deps.redis.set(
          actionKey,
          JSON.stringify({ startedAt: Date.now() }),
          "EX",
          IDEMPOTENCY_TTL_SECONDS,
          "NX"
        );
        // If not claimed AND no on-chain state, something is weird; if not
        // claimed AND on-chain present, the pre-check above already filtered
        // — so this is a safety net only.
        if (claimed !== "OK") {
          joinErrors.set(w.address.toLowerCase(), "action key already held");
          return;
        }

        const kp = await ensureAgentEciesKeypair(
          deps.redis,
          chainId,
          roomId.toString(),
          w.address
        );
        eciesPubByAgent.set(w.address.toLowerCase(), kp.pubHex);

        const gmSignature = await signJoinPermit(roomId, w.address, chainId);
        const nickname = `${req.nicknamePrefix ?? "Agent"} #${w.idx + 1}`;
        const pubKeyBytes = (`0x${kp.pubHex}`) as Hex;

        const wallet = chainAccess.buildAgentWalletClient(w.account);

        const valueForJoin = entryFee + depositPerPlayer;
        const hash = await wallet.writeContract({
          address: diamond,
          abi: DIAMOND_LOBBY_ABI,
          functionName: "joinRoom",
          args: [roomId, nickname, pubKeyBytes, ZERO_ADDR, gmSignature],
          value: valueForJoin,
          gasPrice: parseGwei("10"),
          chain: null,
        } as any);
        await publicClient
          .waitForTransactionReceipt({ hash })
          .catch((err: any) =>
            log.warn(
              { err, hash, agent: w.address },
              "[agents/fill] joinRoom receipt wait failed"
            )
          );
        joinHashes.set(w.address.toLowerCase(), hash);
        log.info({ agent: w.address, hash }, "[agents/fill] joinRoom ok");
      } catch (err: any) {
        joinErrors.set(
          w.address.toLowerCase(),
          String(err?.message ?? err)
        );
        log.error(
          { agent: w.address, err: String(err?.message ?? err) },
          "[agents/fill] joinRoom failed"
        );
      }
    })
  );

  // ── Phase 3: sequential GM registerAgent ────────────────────────────
  // Use the GM wallet from chain.ts — it's the same one configured at startup.
  const gmWallet = gmWalletClient;

  for (const w of funded) {
    const lower = w.address.toLowerCase();
    const topUpTxHash = topUpHashes.get(lower)!;
    const joinTxHash = joinHashes.get(lower);
    const eciesPub = eciesPubByAgent.get(lower) ?? "";

    if (joinErrors.has(lower)) {
      outcomes.push({
        status: "join-failed",
        idx: w.idx,
        agent: w.address,
        err: joinErrors.get(lower)!,
        topUpTxHash,
      });
      continue;
    }
    if (!joinTxHash) {
      outcomes.push({
        status: "join-failed",
        idx: w.idx,
        agent: w.address,
        err: "joinRoom returned no tx hash",
        topUpTxHash,
      });
      continue;
    }

    try {
      const registerTxHash = (await gmWallet.writeContract({
        address: diamond,
        abi: AGENT_REGISTRY_WRITE_ABI,
        functionName: "registerAgent",
        args: [roomId, w.address, POLICY_HASH, MODEL_HASH, META_HASH],
        gasPrice: parseGwei("10"),
        chain: null,
      } as any)) as Hex;
      await publicClient
        .waitForTransactionReceipt({ hash: registerTxHash })
        .catch((err: any) =>
          log.warn(
            { err, registerTxHash },
            "[agents/fill] registerAgent receipt wait failed"
          )
        );
      log.info(
        { agent: w.address, registerTxHash },
        "[agents/fill] registerAgent ok"
      );
      outcomes.push({
        status: "filled",
        idx: w.idx,
        agent: w.address,
        topUpTxHash,
        joinTxHash,
        registerTxHash,
        eciesPubHex: eciesPub,
      });
    } catch (err: any) {
      outcomes.push({
        status: "register-failed",
        idx: w.idx,
        agent: w.address,
        err: String(err?.message ?? err),
        topUpTxHash,
        joinTxHash,
      });
      log.error(
        { agent: w.address, err: String(err?.message ?? err) },
        "[agents/fill] registerAgent failed"
      );
    }
  }

  // Sort by idx for deterministic operator output (parallel join may finish out of order).
  outcomes.sort((a, b) => a.idx - b.idx);

  return { roomId: roomId.toString(), chainId, sponsor: sponsorAddr, outcomes };
}

// Re-export for callers that want to construct manifest hashes themselves.
export { POLICY_HASH, MODEL_HASH, META_HASH };
export { toHex }; // silence unused-import lint in some envs

/**
 * routes/agentRoutes.ts — HTTP control surface for the agent subsystem.
 *
 * Currently exposes:
 *   POST /agents/fill-room   {roomId, chainId?, agentCount, nicknamePrefix?}
 *     → provisions agents into a LOBBY room. Sequential sponsor top-ups,
 *       parallel joinRoom, sequential GM registerAgent. Returns per-agent
 *       outcomes with tx hashes.
 *   GET  /agents/status
 *     → reports subsystem readiness (AGENTS_ENABLED, sponsor address +
 *       balance per chain, mnemonic present). Useful smoke-check before
 *       firing a fill-room.
 *
 * Auth model for the spike: gated by `AGENTS_ENABLED=true` AND an optional
 * `X-Agents-Api-Key` header matching `AGENTS_API_KEY` env. If `AGENTS_API_KEY`
 * is unset, no key is required (testnet convenience). Tighten before mainnet.
 *
 * Rate limit: actionLimiter (15 req/sec) — fill-room itself is heavy but
 * idempotent, so we don't reach for heavyLimiter.
 */
import { Router } from "express";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { logger } from "../utils/logger.js";
import { fillRoomWithAgents } from "../agents/fill-room.js";
import { getSponsorAddress, getSponsorBalance } from "../agents/sponsor.js";
import { getRedis } from "../redis.js";

/**
 * Routes are registered at boot, BEFORE connectRedis() — so capturing
 * `getRedis()` here would freeze the null pre-connect value. Resolve lazily
 * per request via the redis module's getter.
 */
export interface AgentRoutesContext {
  actionLimiter: RateLimitRequestHandler;
}

function isEnabled(): boolean {
  return (process.env.AGENTS_ENABLED ?? "").toLowerCase() === "true";
}

function authOk(req: any): boolean {
  const required = process.env.AGENTS_API_KEY;
  if (!required) return true; // open access — fine for testnet, NOT for mainnet
  // Express normalises headers to lowercase — the capital-case fallback was dead code.
  const provided = req.headers["x-agents-api-key"];
  return typeof provided === "string" && provided === required;
}

export function createAgentRoutes(ctx: AgentRoutesContext) {
  const router = Router();

  router.use((req, res, next) => {
    if (!isEnabled()) {
      return res.status(503).json({
        error: "agent subsystem disabled (set AGENTS_ENABLED=true)",
      });
    }
    if (!authOk(req)) {
      return res.status(401).json({ error: "missing or invalid X-Agents-Api-Key" });
    }
    next();
  });

  // ── POST /agents/fill-room ───────────────────────────────────────
  router.post("/agents/fill-room", ctx.actionLimiter, async (req, res) => {
    try {
      const roomIdRaw = req.body?.roomId;
      if (roomIdRaw == null) {
        return res.status(400).json({ error: "missing roomId" });
      }
      let roomId: bigint;
      try {
        roomId = BigInt(roomIdRaw);
      } catch {
        return res.status(400).json({ error: "roomId not parseable as bigint" });
      }
      const chainId = Number(req.body?.chainId ?? 50312);
      const agentCount = Number(req.body?.agentCount ?? 5);
      const nicknamePrefix =
        typeof req.body?.nicknamePrefix === "string"
          ? req.body.nicknamePrefix
          : undefined;

      const redis = getRedis();
      if (!redis) {
        return res.status(503).json({
          error: "Redis not connected — agent subsystem cannot persist trace material",
        });
      }
      const result = await fillRoomWithAgents(
        { chainId, roomId, agentCount, nicknamePrefix },
        { redis }
      );

      // Serialise bigints/hex-keys to strings for safe JSON.
      return res.json({
        roomId: result.roomId,
        chainId: result.chainId,
        sponsor: result.sponsor,
        outcomes: result.outcomes,
      });
    } catch (err: any) {
      logger.error({ err: err?.message ?? err }, "[agents/fill-room] failed");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // ── GET /agents/status ───────────────────────────────────────────
  router.get("/agents/status", async (req, res) => {
    try {
      const chainIdsRaw = req.query?.chainIds ?? "50312";
      const chainIds = String(chainIdsRaw)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

      let sponsor: string;
      try {
        sponsor = getSponsorAddress();
      } catch (err: any) {
        return res.status(500).json({
          enabled: isEnabled(),
          error: `sponsor not initialised: ${String(err?.message ?? err)}`,
        });
      }

      const balances = await Promise.all(
        chainIds.map(async (cid) => {
          try {
            const bal = await getSponsorBalance(cid);
            return { chainId: cid, balanceWei: bal.toString() };
          } catch (err: any) {
            return {
              chainId: cid,
              error: String(err?.message ?? err),
            };
          }
        })
      );

      return res.json({
        enabled: isEnabled(),
        mnemonicSet: Boolean(process.env.AGENT_MASTER_MNEMONIC),
        sponsor,
        balances,
      });
    } catch (err: any) {
      logger.error({ err: err?.message ?? err }, "[agents/status] failed");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  return router;
}

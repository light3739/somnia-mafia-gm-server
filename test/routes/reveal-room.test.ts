import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock the core + wiring so the route is tested without a chain.
vi.mock("../../src/agents/reveal-trace.js", () => ({
  revealRoomTraces: vi.fn().mockResolvedValue({
    roomId: "72", status: "ok", total: 2, revealed: 2, skipped: [], failed: [], txHashes: ["0xa", "0xb"],
  }),
}));
vi.mock("../../src/agents/reveal-deps.js", () => ({
  buildRevealDeps: vi.fn().mockReturnValue({}),
}));
vi.mock("../../src/redis.js", () => ({ getRedis: () => ({}) }));

import { createAgentRoutes } from "../../src/routes/agentRoutes.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use(createAgentRoutes({ actionLimiter: (_req: any, _res: any, next: any) => next() } as any));
  return a;
}

describe("POST /agents/reveal-room", () => {
  beforeEach(() => { process.env.AGENTS_ENABLED = "true"; delete process.env.AGENTS_API_KEY; });

  it("400 on missing roomId", async () => {
    const res = await request(app()).post("/agents/reveal-room").send({ chainId: 50312 });
    expect(res.status).toBe(400);
  });

  it("400 on non-testnet chainId", async () => {
    const res = await request(app()).post("/agents/reveal-room").send({ roomId: "72", chainId: 1 });
    expect(res.status).toBe(400);
  });

  it("200 returns the reveal report", async () => {
    const res = await request(app()).post("/agents/reveal-room").send({ roomId: "72", chainId: 50312 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roomId: "72", revealed: 2, txHashes: ["0xa", "0xb"] });
  });
});

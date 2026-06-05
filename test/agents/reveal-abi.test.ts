import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAbiItem } from "viem";
import { AGENT_REGISTRY_ABI } from "../../src/agents/registry-abi.js";

const B32 = (b: string) => ("0x" + b.repeat(32)) as `0x${string}`;

describe("AGENT_REGISTRY_ABI reveal surface", () => {
  it("exposes revealAgentInferenceTrace with the deployed selector 0x7c9fbbc0", () => {
    const data = encodeFunctionData({
      abi: AGENT_REGISTRY_ABI,
      functionName: "revealAgentInferenceTrace",
      args: [
        1n,
        B32("11"),
        "0x0000000000000000000000000000000000000001",
        0n,
        B32("22"),
        B32("33"),
        B32("44"),
        B32("55"),
      ],
    });
    expect(data.startsWith("0x7c9fbbc0")).toBe(true);
  });

  it("exposes the AgentInferenceRevealed event", () => {
    const ev = getAbiItem({ abi: AGENT_REGISTRY_ABI, name: "AgentInferenceRevealed" });
    expect(ev).toBeTruthy();
    expect(ev?.type).toBe("event");
  });
});

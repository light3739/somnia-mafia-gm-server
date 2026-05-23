import { describe, it, expect, vi } from "vitest";
import { turnController } from "../../src/agents/turnController.js";
import { notifySpeakerChanged } from "../../src/routes/discussionRoutes.js";

describe("notifySpeakerChanged", () => {
  it("forwards (roomId, chainId, dayCount) to turnController.onSpeakerChanged(chainId, roomId, dayCount)", () => {
    const spy = vi.spyOn(turnController, "onSpeakerChanged").mockResolvedValue(undefined);
    notifySpeakerChanged(8, 50312, 1);
    expect(spy).toHaveBeenCalledWith(50312, "8", 1);
    spy.mockRestore();
  });
});

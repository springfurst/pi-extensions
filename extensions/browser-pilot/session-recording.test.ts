import { describe, expect, it, vi } from "vitest";
import { RecordingController } from "./session-recording";
import type { BrowserPilotSession } from "./session";

function session(): BrowserPilotSession {
  return {
    tabs: new Map(),
    clearNetworkDetails: vi.fn(),
    listTabs: vi.fn(async () => []),
  } as unknown as BrowserPilotSession;
}

describe("RecordingController HAR state", () => {
  it("rejects a second start and a stop without a start", async () => {
    const controller = new RecordingController(session());
    await expect(controller.stopHar()).rejects.toThrow(/No HAR recording/);
    controller.startHar();
    expect(controller.isRecordingHar).toBe(true);
    expect(() => controller.startHar()).toThrow(/already active/);
    const result = await controller.stopHar();
    expect(result.entries).toBe(0);
    expect(controller.isRecordingHar).toBe(false);
    await expect(controller.stopHar()).rejects.toThrow(/No HAR recording/);
  });
});

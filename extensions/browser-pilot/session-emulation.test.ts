import { describe, expect, it } from "vitest";
import { EmulationController } from "./session-emulation";
import type { BrowserPilotSession } from "./session";

function fakePage(calls: string[]): Parameters<EmulationController["apply"]>[0] {
  return {
    setViewport: async () => {
      calls.push("viewport");
    },
    setUserAgent: async () => {
      calls.push("user-agent");
    },
    createCDPSession: async () => ({
      send: async (name: string) => {
        calls.push(name);
      },
      detach: async () => undefined,
    }),
    emulateNetworkConditions: async () => {
      calls.push("network");
    },
    setGeolocation: async () => {
      calls.push("geolocation");
    },
  } as unknown as Parameters<EmulationController["apply"]>[0];
}

function controller(): EmulationController {
  const session = {
    config: { viewport: { width: 1365, height: 768 } },
  } as unknown as BrowserPilotSession;
  return new EmulationController(session);
}

describe("EmulationController.apply", () => {
  it("clears network conditions before a viewport reload", async () => {
    const calls: string[] = [];
    const emulation = controller();
    emulation.state = {
      viewport: { width: 800, height: 600, isMobile: true },
      network: null,
    };
    await emulation.apply(fakePage(calls));
    expect(calls.indexOf("network")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("network")).toBeLessThan(calls.indexOf("viewport"));
  });

  it("applies offline after a viewport reload", async () => {
    const calls: string[] = [];
    const emulation = controller();
    emulation.state = {
      viewport: { width: 800, height: 600, isMobile: true },
      network: { offline: true, latency: 0, download: 0, upload: 0 },
    };
    await emulation.apply(fakePage(calls));
    expect(calls.indexOf("viewport")).toBeLessThan(calls.indexOf("network"));
  });
});

import type { Page, Permission } from "puppeteer-core";
import { fingerprintFor } from "../../lib/browser/fingerprint";
import type { BrowserPilotSession } from "./session";
import type { EmulationState, TabInfo } from "./types";
import { BrowserPilotError } from "./types";

export type NetworkProfileName = "offline" | "slow3g" | "fast3g" | "slow4g" | "fast4g";

const NETWORK_PROFILES: Record<
  NetworkProfileName,
  { latency: number; download: number; upload: number }
> = {
  offline: { latency: 0, download: 0, upload: 0 },
  slow3g: { latency: 2000, download: 50_000, upload: 20_000 },
  fast3g: { latency: 150, download: 180_000, upload: 80_000 },
  slow4g: { latency: 100, download: 500_000, upload: 250_000 },
  fast4g: { latency: 20, download: 4_000_000, upload: 1_000_000 },
};

export class EmulationController {
  state: EmulationState = {};

  constructor(private readonly session: BrowserPilotSession) {}

  /** Apply the session's emulation overrides to one page. */
  async apply(page: Page): Promise<void> {
    const state = this.state;
    const viewport = state.viewport ?? {
      width: this.session.config.viewport.width,
      height: this.session.config.viewport.height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      isMobile: viewport.isMobile ?? false,
      hasTouch: viewport.hasTouch ?? false,
    });
    // Only override the user agent when one was configured or emulated; the
    // real binary's identity is the consistent default.
    const userAgent = state.userAgent ?? this.session.config.userAgent;
    if (userAgent) {
      const fingerprint = fingerprintFor(this.session.instance?.chromeVersion ?? "");
      await page.setUserAgent({
        userAgent,
        userAgentMetadata: fingerprint.metadata,
      });
    }
    const client = await page.createCDPSession();
    try {
      await client.send("Emulation.setEmulatedMedia", {
        features: [
          ...(state.colorScheme
            ? [{ name: "prefers-color-scheme", value: state.colorScheme }]
            : []),
          ...(state.reducedMotion
            ? [{ name: "prefers-reduced-motion", value: state.reducedMotion }]
            : []),
        ],
      });
      await client.send("Emulation.setCPUThrottlingRate", {
        rate: state.cpuThrottle ?? 1,
      });
      const locale = state.locale ?? this.session.config.locale;
      const timezone = state.timezone ?? this.session.config.timezone;
      if (locale) {
        await client.send("Emulation.setLocaleOverride", { locale });
      } else {
        await client.send("Emulation.setLocaleOverride", { locale: "" }).catch(() => undefined);
      }
      if (timezone) {
        await client.send("Emulation.setTimezoneOverride", { timezoneId: timezone });
      } else {
        await client
          .send("Emulation.setTimezoneOverride", { timezoneId: "" })
          .catch(() => undefined);
      }
    } finally {
      await client.detach().catch(() => undefined);
    }
    if (state.network !== undefined) {
      await page.emulateNetworkConditions(state.network).catch(() => undefined);
    }
    if (state.geolocation) {
      await page.setGeolocation(state.geolocation).catch(() => undefined);
    } else {
      const geoClient = await page.createCDPSession();
      await geoClient
        .send("Emulation.clearGeolocationOverride")
        .catch(() => undefined)
        .finally(() => geoClient.detach().catch(() => undefined));
    }
  }

  /** Replace the emulation state and apply it to the current tab. */
  async set(tabHandle: number | undefined, state: EmulationState): Promise<TabInfo> {
    const tab = await this.session.ensureTab(tabHandle);
    this.state = state;
    await this.apply(tab.page);
    const infos = await this.session.listTabs();
    return infos.find((info) => info.handle === tab.handle)!;
  }

  /** Build the network emulation condition for a named profile. */
  networkProfile(name: NetworkProfileName) {
    return NETWORK_PROFILES[name];
  }

  /** Grant or clear browser permissions for one origin. */
  async setPermissions(
    permissions: string[],
    origin?: string,
    tabHandle?: number,
  ): Promise<{ origin: string; permissions: string[] }> {
    await this.session.ensure();
    const tab = await this.session.ensureTab(tabHandle);
    let targetOrigin = origin;
    if (!targetOrigin) {
      try {
        targetOrigin = new URL(tab.page.url()).origin;
      } catch {
        throw new BrowserPilotError(
          "emulate permissions requires origin on an about:blank page.",
          'Pass origin:"https://example.com" together with permissions.',
        );
      }
    }
    await this.session
      .browser!.defaultBrowserContext()
      .overridePermissions(targetOrigin, permissions as Permission[]);
    return { origin: targetOrigin, permissions };
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookiesForUrl,
  createBrowserRenderer,
  detectSystemBrowser,
  disposeSharedBrowser,
  isBlockedRequestUrl,
  resolveBrowserExecutable,
  systemBrowserCandidates,
  type BrowserPage,
  type InterceptableRequest,
} from "./browser";
import { BrowserRuntime } from "./browser/runtime";
import type { EnsureChromeOptions } from "./browser/launch";
import type { ChromeInstance, ProfileInfo } from "./browser/profile";
import { DEFAULT_CONFIG } from "./config";

class FakeRequest implements InterceptableRequest {
  readonly actions: string[] = [];
  constructor(
    private readonly target: string,
    private readonly navigation = false,
    private readonly documentUrl?: string,
    private readonly kind?: string,
  ) {}

  url(): string {
    return this.target;
  }

  isNavigationRequest(): boolean {
    return this.navigation;
  }

  resourceType(): string {
    return this.kind ?? "";
  }

  frame(): { url(): string } | null {
    return this.documentUrl ? { url: () => this.documentUrl! } : null;
  }

  async continue(): Promise<void> {
    this.actions.push("continue");
  }

  async abort(): Promise<void> {
    this.actions.push("abort");
  }
}

class FakePage implements BrowserPage {
  readonly navigations: string[] = [];
  readonly waited: string[] = [];
  readonly requests: FakeRequest[] = [];
  readonly gotoOptions: Array<{ waitUntil?: string; timeout?: number }> = [];
  closed = false;
  html = "<html><body>rendered</body></html>";
  status = 200;
  currentUrl = "about:blank";
  private requestHandler?: (request: InterceptableRequest) => void;

  isClosed(): boolean {
    return this.closed;
  }

  on(_event: "request", handler: (request: InterceptableRequest) => void): void {
    this.requestHandler = handler;
  }

  async setRequestInterception(): Promise<void> {}

  async setViewport(): Promise<void> {}

  async setUserAgent(): Promise<void> {}

  async goto(
    url: string,
    options: { waitUntil?: string; timeout?: number } = {},
  ): Promise<{ status(): number }> {
    this.navigations.push(url);
    this.gotoOptions.push(options);
    this.currentUrl = url;
    return { status: () => this.status };
  }

  async content(): Promise<string> {
    return this.html;
  }

  url(): string {
    return this.currentUrl;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async waitForSelector(selector: string): Promise<unknown> {
    this.waited.push(selector);
    return null;
  }

  dispatch(
    url: string,
    navigation = false,
    options: { documentUrl?: string; resourceType?: string } = {},
  ): FakeRequest {
    const request = new FakeRequest(url, navigation, options.documentUrl, options.resourceType);
    this.requests.push(request);
    this.requestHandler?.(request);
    return request;
  }
}

class FakeBrowser {
  readonly pages: FakePage[] = [];
  connected = true;
  closeCount = 0;
  disconnected?: () => void;
  cookiesList: Array<{ name: string; value: string }> = [];

  async cookies(): Promise<Array<{ name: string; value: string }>> {
    return this.cookiesList;
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async allPages(): Promise<FakePage[]> {
    return this.pages;
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.connected = false;
  }

  disconnect(): void {
    this.connected = false;
  }

  on(_event: "disconnected", handler: () => void): void {
    this.disconnected = handler;
  }
}

const INSTANCE: ChromeInstance = {
  pid: 0,
  port: 1,
  wsEndpoint: "ws://127.0.0.1:1/devtools/browser/x",
  userDataDir: "/profiles/warm",
  executablePath: "/fake/chrome",
  startedAt: "2026-01-01T00:00:00.000Z",
  ownerSessionId: "test",
};

const PROFILE: ProfileInfo = {
  key: "path-warm",
  userDataDir: "/profiles/warm",
  label: "/profiles/warm",
  persistent: true,
};

function runtimeFor(
  browser: FakeBrowser,
  overrides: {
    ensure?: (options: EnsureChromeOptions) => Promise<{
      instance: ChromeInstance;
      profile: ProfileInfo;
      attached?: boolean;
    }>;
  } = {},
): BrowserRuntime {
  return new BrowserRuntime({
    agentDir: "/agent",
    cwd: "/cwd",
    config: {
      profile: "shared",
      headless: true,
      viewport: { width: 1365, height: 768 },
      stealth: "basic",
      noSandbox: false,
      args: [],
      executablePath: "/fake/chrome",
    },
    attach: true,
    maxPages: 4,
    maxTabsPerSession: 1,
    ensure:
      overrides.ensure ?? (async () => ({ instance: INSTANCE, profile: PROFILE, attached: false })),
    connect: async () => browser as never,
    closeBrowser: async () => undefined,
  });
}

function rendererOptions(runtime: BrowserRuntime, overrides: Record<string, unknown> = {}) {
  return {
    agentDir: "/agent",
    cwd: "/cwd",
    config: DEFAULT_CONFIG.browser,
    runtimeConfig: DEFAULT_CONFIG.runtime,
    executablePath: "/fake/chrome",
    runtime,
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveBrowserExecutable", () => {
  it("prefers the environment, then config, then detection", async () => {
    const detect = async () => "/detected/chrome";
    expect(
      await resolveBrowserExecutable({
        env: { PUPPETEER_EXECUTABLE_PATH: "/env/chrome" },
        executablePath: "/config/chrome",
        detect,
      }),
    ).toBe("/env/chrome");
    expect(
      await resolveBrowserExecutable({ env: {}, executablePath: "/config/chrome", detect }),
    ).toBe("/config/chrome");
    expect(await resolveBrowserExecutable({ env: {}, detect })).toBe("/detected/chrome");
    expect(
      await resolveBrowserExecutable({ env: {}, detect: async () => undefined }),
    ).toBeUndefined();
  });

  it("prefers the configured path when asked", async () => {
    expect(
      await resolveBrowserExecutable({
        env: { PUPPETEER_EXECUTABLE_PATH: "/env/chrome" },
        executablePath: "/config/chrome",
        preferConfigured: true,
      }),
    ).toBe("/config/chrome");
  });

  it("memoizes detection for the same detect function", async () => {
    const detect = vi.fn(async () => "/detected/chrome");
    expect(await resolveBrowserExecutable({ env: {}, detect })).toBe("/detected/chrome");
    expect(await resolveBrowserExecutable({ env: {}, detect })).toBe("/detected/chrome");
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("does not share detection between different detect functions", async () => {
    const first = vi.fn(async () => "/one/chrome");
    const second = vi.fn(async () => "/two/chrome");
    await resolveBrowserExecutable({ env: {}, detect: first });
    expect(await resolveBrowserExecutable({ env: {}, detect: second })).toBe("/two/chrome");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("systemBrowserCandidates", () => {
  it("lists Linux PATH hits before fixed paths", () => {
    const candidates = systemBrowserCandidates({
      platform: "linux",
      env: {},
      home: "/home/u",
      which: (name) => (name === "chromium" ? "/opt/chromium" : undefined),
    });
    expect(candidates[0]).toBe("/opt/chromium");
    expect(candidates).toContain("/usr/bin/google-chrome");
  });

  it("lists macOS application bundles", () => {
    const candidates = systemBrowserCandidates({ platform: "darwin", env: {}, home: "/Users/u" });
    expect(candidates.some((path) => path.includes("Google Chrome.app"))).toBe(true);
    expect(candidates.some((path) => path.includes("Microsoft Edge.app"))).toBe(true);
  });

  it("lists Windows install locations", () => {
    const candidates = systemBrowserCandidates({
      platform: "win32",
      env: { ProgramFiles: "C:\\PF" },
      home: "C:\\Users\\u",
    });
    expect(
      candidates.some((path) => path.endsWith("Google\\Chrome\\Application\\chrome.exe")),
    ).toBe(true);
    expect(
      candidates.some((path) => path.endsWith("Microsoft\\Edge\\Application\\msedge.exe")),
    ).toBe(true);
  });
});

describe("detectSystemBrowser", () => {
  it("returns the first executable candidate", async () => {
    const inspected: string[] = [];
    const found = await detectSystemBrowser({
      platform: "linux",
      env: {},
      home: "/home/u",
      which: () => undefined,
      isExecutable: (path) => path === "/usr/bin/google-chrome",
      probe: async (path) => {
        inspected.push(path);
        return true;
      },
    });
    expect(found).toBe("/usr/bin/google-chrome");
    expect(inspected).toEqual(["/usr/bin/google-chrome"]);
  });

  it("skips candidates that fail the Linux version probe", async () => {
    const found = await detectSystemBrowser({
      platform: "linux",
      env: {},
      home: "/home/u",
      which: () => undefined,
      isExecutable: (path) => path === "/usr/bin/google-chrome" || path === "/usr/bin/chromium",
      probe: async (path) => path === "/usr/bin/chromium",
    });
    expect(found).toBe("/usr/bin/chromium");
  });
});

describe("isBlockedRequestUrl", () => {
  it("blocks non-HTTP schemes and private hosts, honoring the opt-out", () => {
    expect(isBlockedRequestUrl("file:///etc/passwd", false)).toBe(true);
    expect(isBlockedRequestUrl("http://127.0.0.1/", false)).toBe(true);
    expect(isBlockedRequestUrl("http://localhost/", false)).toBe(true);
    expect(isBlockedRequestUrl("http://169.254.169.254/latest/meta-data", false)).toBe(true);
    expect(isBlockedRequestUrl("https://example.com/", false)).toBe(false);
    expect(isBlockedRequestUrl("http://127.0.0.1/", true)).toBe(false);
    expect(isBlockedRequestUrl("ftp://example.com/", true)).toBe(true);
  });
});

describe("createBrowserRenderer", () => {
  it("returns undefined when disabled", async () => {
    const renderer = await createBrowserRenderer({
      agentDir: "/agent",
      cwd: "/cwd",
      config: { ...DEFAULT_CONFIG.browser, enabled: false },
      runtimeConfig: DEFAULT_CONFIG.runtime,
      executablePath: "/fake/chrome",
    });
    expect(renderer).toBeUndefined();
  });

  it("returns undefined when no browser resolves", async () => {
    const renderer = await createBrowserRenderer({
      agentDir: "/agent",
      cwd: "/cwd",
      config: DEFAULT_CONFIG.browser,
      runtimeConfig: DEFAULT_CONFIG.runtime,
      detection: { isExecutable: () => false, which: () => undefined },
    });
    expect(renderer).toBeUndefined();
  });

  it("renders through the shared runtime and closes the page", async () => {
    const browser = new FakeBrowser();
    const runtime = runtimeFor(browser);
    try {
      const renderer = await createBrowserRenderer(rendererOptions(runtime));
      const page = await renderer!("https://93.184.216.34/");
      expect(page.html).toContain("rendered");
      expect(page.status).toBe(200);
      expect(page.finalUrl).toBe("https://93.184.216.34/");
      expect(browser.pages).toHaveLength(1);
      expect(browser.pages[0]!.closed).toBe(true);
    } finally {
      await runtime.releaseAll();
    }
  });

  it("warms cookies at the home URL and waits for a ready selector", async () => {
    const browser = new FakeBrowser();
    const runtime = runtimeFor(browser);
    try {
      const renderer = await createBrowserRenderer(rendererOptions(runtime));
      await renderer!("https://example.com/search?q=x", {
        homeUrl: "https://example.com/",
        readySelector: "a h3",
      });
      const page = browser.pages[0]!;
      expect(page.navigations).toEqual(["https://example.com/", "https://example.com/search?q=x"]);
      expect(page.waited).toEqual(["a h3"]);
    } finally {
      await runtime.releaseAll();
    }
  });

  it("clamps the navigation deadline to browser.timeoutSeconds", async () => {
    const browser = new FakeBrowser();
    const runtime = runtimeFor(browser);
    try {
      const renderer = await createBrowserRenderer(
        rendererOptions(runtime, {
          config: { ...DEFAULT_CONFIG.browser, timeoutSeconds: 5 },
        }),
      );
      await renderer!("https://93.184.216.34/", { timeoutMs: 60_000 });
      expect(browser.pages[0]!.gotoOptions.at(-1)?.timeout).toBe(5_000);
      await renderer!("https://93.184.216.34/", { timeoutMs: 1_000 });
      expect(browser.pages[1]!.gotoOptions.at(-1)?.timeout).toBe(1_000);
    } finally {
      await runtime.releaseAll();
    }
  });

  it("applies blocking and the per-host allow list", async () => {
    const browser = new FakeBrowser();
    const runtime = runtimeFor(browser);
    try {
      const renderer = await createBrowserRenderer(
        rendererOptions(runtime, {
          blocking: {
            ads: "third-party",
            analytics: "third-party",
            images: "third-party",
            media: "third-party",
            fonts: "third-party",
          },
          hosts: { "example.com": { allow: ["images"] } },
        }),
      );
      await renderer!("https://93.184.216.34/page");
      const page = browser.pages[0]!;
      const documentUrl = "https://example.com/page";
      const ownImage = page.dispatch("https://example.com/logo.png", false, {
        documentUrl,
        resourceType: "image",
      });
      const allowedImage = page.dispatch("https://cdn.example.net/logo.png", false, {
        documentUrl,
        resourceType: "image",
      });
      const tracker = page.dispatch("https://www.google-analytics.com/collect", false, {
        documentUrl,
        resourceType: "script",
      });
      await tick();
      expect(ownImage.actions).toEqual(["continue"]);
      expect(allowedImage.actions).toEqual(["continue"]);
      expect(tracker.actions).toEqual(["abort"]);
    } finally {
      await runtime.releaseAll();
    }
  });

  it("releases the lease on idle close and reopens on the next render", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const ensure = vi.fn(async () => ({ instance: INSTANCE, profile: PROFILE, attached: false }));
    const runtime = runtimeFor(browser, { ensure });
    try {
      const renderer = await createBrowserRenderer(
        rendererOptions(runtime, {
          config: { ...DEFAULT_CONFIG.browser, idleCloseSeconds: 1 },
        }),
      );
      await renderer!("https://93.184.216.34/a");
      expect(ensure).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await renderer!("https://93.184.216.34/b");
      expect(ensure).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await runtime.releaseAll();
    }
  });

  it("reads probe cookies from a browser this process already has open", async () => {
    const browser = new FakeBrowser();
    browser.cookiesList = [{ name: "session", value: "abc" }];
    const runtime = runtimeFor(browser);
    try {
      expect(await cookiesForUrl(runtime, "https://example.com/page")).toBeUndefined();
      await runtime.acquire("browser-pilot");
      expect(await cookiesForUrl(runtime, "https://example.com/page")).toBe("session=abc");
      await runtime.releaseAll();
      expect(await cookiesForUrl(runtime, "https://example.com/page")).toBeUndefined();
    } finally {
      await runtime.releaseAll();
    }
  });

  it("passes the profile path and launch mode to the runtime it opens", async () => {
    const browser = new FakeBrowser();
    let seen: EnsureChromeOptions | undefined;
    try {
      const renderer = await createBrowserRenderer({
        agentDir: "/agent",
        cwd: "/cwd",
        config: { ...DEFAULT_CONFIG.browser, userDataDir: "/profiles/warm" },
        runtimeConfig: { ...DEFAULT_CONFIG.runtime, headless: true },
        executablePath: "/fake/chrome",
        ensure: async (options) => {
          seen = options;
          return { instance: INSTANCE, profile: PROFILE, attached: false };
        },
        connect: async () => browser as never,
        closeBrowser: async () => undefined,
      });
      expect(renderer).toBeDefined();
      await renderer!("https://93.184.216.34/");
      expect(seen?.config.profile).toBe("/profiles/warm");
      expect(seen?.config.headless).toBe(true);
    } finally {
      await disposeSharedBrowser();
    }
  });
});

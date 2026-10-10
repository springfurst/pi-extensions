import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSession,
  createBrowserRenderer,
  detectSystemBrowser,
  disposeSharedBrowser,
  isBlockedRequestUrl,
  resolveBrowserExecutable,
  systemBrowserCandidates,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserPage,
  type InterceptableRequest,
} from "./browser";
import { DEFAULT_CONFIG } from "./config";

class FakeRequest implements InterceptableRequest {
  readonly actions: string[] = [];
  constructor(private readonly target: string) {}

  url(): string {
    return this.target;
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
  closed = false;
  html = "<html><body>rendered</body></html>";
  status = 200;
  currentUrl = "about:blank";
  private requestHandler?: (request: InterceptableRequest) => void;

  on(_event: "request", handler: (request: InterceptableRequest) => void): void {
    this.requestHandler = handler;
  }

  async setRequestInterception(): Promise<void> {}

  async setViewport(): Promise<void> {}

  async setUserAgent(): Promise<void> {}

  async goto(url: string): Promise<{ status(): number }> {
    this.navigations.push(url);
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

  dispatch(url: string): FakeRequest {
    const request = new FakeRequest(url);
    this.requests.push(request);
    this.requestHandler?.(request);
    return request;
  }
}

class FakeBrowser implements BrowserInstance {
  readonly pages: FakePage[] = [];
  closeCount = 0;
  disconnected?: () => void;

  async newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closeCount++;
  }

  on(_event: "disconnected", handler: () => void): void {
    this.disconnected = handler;
  }
}

function sessionFor(browser: FakeBrowser, overrides: Partial<BrowserSessionOptions> = {}) {
  return new BrowserSession({
    executablePath: "/fake/chrome",
    allowPrivateHosts: true,
    launch: async () => browser,
    ...overrides,
  });
}

type BrowserSessionOptions = ConstructorParameters<typeof BrowserSession>[0];

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

describe("BrowserSession", () => {
  it("launches once, reuses the browser, and closes each page", async () => {
    const browser = new FakeBrowser();
    let launches = 0;
    const session = new BrowserSession({
      executablePath: "/fake/chrome",
      allowPrivateHosts: true,
      launch: async () => {
        launches++;
        return browser;
      },
    });

    await session.render("https://example.com/a");
    await session.render("https://example.com/b");

    expect(launches).toBe(1);
    expect(browser.pages).toHaveLength(2);
    expect(browser.pages.every((page) => page.closed)).toBe(true);

    await session.dispose();
    expect(browser.closeCount).toBe(1);
    await expect(session.render("https://example.com/c")).rejects.toThrow(/disposed/);
  });

  it("reuses a configured user data directory across launches", async () => {
    const browser = new FakeBrowser();
    const launches: BrowserLaunchOptions[] = [];
    const session = new BrowserSession({
      executablePath: "/fake/chrome",
      userDataDir: "/profiles/warm",
      allowPrivateHosts: true,
      launch: async (options) => {
        launches.push(options);
        return browser;
      },
    });

    await session.render("https://example.com/a");
    await session.render("https://example.com/b");

    expect(launches).toHaveLength(1);
    expect(launches[0]?.userDataDir).toBe("/profiles/warm");
    await session.dispose();
  });

  it("warms cookies and waits for a ready selector", async () => {
    const browser = new FakeBrowser();
    const session = sessionFor(browser);
    await session.render("https://example.com/search", {
      homeUrl: "https://example.com/",
      readySelector: "h3",
    });
    const page = browser.pages[0]!;
    expect(page.navigations).toEqual(["https://example.com/", "https://example.com/search"]);
    expect(page.waited).toEqual(["h3"]);
    await session.dispose();
  });

  it("caps concurrent pages at maxPages", async () => {
    const browser = new FakeBrowser();
    let live = 0;
    let peak = 0;
    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await originalNewPage();
      live++;
      peak = Math.max(peak, live);
      const originalClose = page.close.bind(page);
      page.close = async () => {
        await originalClose();
        live--;
      };
      return page;
    };
    const session = sessionFor(browser, { maxPages: 1 });
    await Promise.all([session.render("https://a.test/"), session.render("https://b.test/")]);
    expect(peak).toBe(1);
    await session.dispose();
  });

  it("aborts blocked requests through interception", async () => {
    const browser = new FakeBrowser();
    const session = new BrowserSession({
      executablePath: "/fake/chrome",
      allowPrivateHosts: false,
      launch: async () => browser,
    });
    // A literal public IP skips DNS resolution in the initial guard.
    await session.render("https://93.184.216.34/");
    const page = browser.pages[0]!;
    const blocked = page.dispatch("file:///etc/passwd");
    const privateHost = page.dispatch("http://10.0.0.1/admin");
    const allowed = page.dispatch("https://cdn.example.com/app.js");
    await tick();
    expect(blocked.actions).toEqual(["abort"]);
    expect(privateHost.actions).toEqual(["abort"]);
    expect(allowed.actions).toEqual(["continue"]);
    await session.dispose();
  });

  it("closes the browser after the idle period", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const session = sessionFor(browser, { idleCloseMs: 1_000 });
    await session.render("https://example.com/");
    expect(browser.closeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(browser.closeCount).toBe(1);
  });
});

describe("createBrowserRenderer", () => {
  it("returns undefined when disabled", async () => {
    const renderer = await createBrowserRenderer({
      config: { ...DEFAULT_CONFIG.browser, enabled: false },
      executablePath: "/fake/chrome",
    });
    expect(renderer).toBeUndefined();
  });

  it("returns undefined when no browser resolves", async () => {
    const renderer = await createBrowserRenderer({
      config: DEFAULT_CONFIG.browser,
      detection: { isExecutable: () => false, which: () => undefined },
    });
    expect(renderer).toBeUndefined();
  });

  it("routes renders through the supplied session", async () => {
    const browser = new FakeBrowser();
    const session = sessionFor(browser);
    const renderer = await createBrowserRenderer({
      config: DEFAULT_CONFIG.browser,
      executablePath: "/fake/chrome",
      session,
    });
    expect(renderer).toBeDefined();
    const page = await renderer!("https://example.com/");
    expect(page.html).toContain("rendered");
    await session.dispose();
  });

  it("passes the configured user data directory to the shared session", async () => {
    const browser = new FakeBrowser();
    const launches: BrowserLaunchOptions[] = [];
    try {
      const renderer = await createBrowserRenderer({
        config: { ...DEFAULT_CONFIG.browser, userDataDir: "/profiles/warm" },
        executablePath: "/fake/chrome",
        launch: async (options) => {
          launches.push(options);
          return browser;
        },
      });
      expect(renderer).toBeDefined();
      await renderer!("https://example.com/");
      expect(launches[0]?.userDataDir).toBe("/profiles/warm");
    } finally {
      await disposeSharedBrowser();
    }
  });
});

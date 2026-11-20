import { describe, expect, it } from "vitest";
import { FakeClock, flush } from "../web/__fixtures__/clock";
import type { ChromeInstance, ProfileInfo } from "./profile";
import {
  BrowserRuntime,
  TabLimitError,
  type BrowserLike,
  type ContextLike,
  type PageLike,
} from "./runtime";

class FakePage implements PageLike {
  closed = false;

  url(): string {
    return "about:blank";
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser implements BrowserLike {
  connected = true;
  closed = false;
  contexts = 0;
  readonly pagesList: FakePage[] = [];
  private readonly handlers: Array<() => void> = [];

  async newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pagesList.push(page);
    return page;
  }

  async pages(): Promise<FakePage[]> {
    return this.pagesList;
  }

  on(_event: "disconnected", listener: () => void): unknown {
    this.handlers.push(listener);
    return this;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }

  disconnect(): void {
    this.connected = false;
  }

  async createBrowserContext(): Promise<ContextLike> {
    this.contexts++;
    const page = async () => {
      const created = new FakePage();
      this.pagesList.push(created);
      return created;
    };
    return { newPage: page, close: async () => undefined };
  }
}

interface Harness {
  runtime: BrowserRuntime;
  clock: FakeClock;
  browser: FakeBrowser;
  ensureCalls: string[];
  closedBrowsers: number;
  profile: ProfileInfo;
  instance: ChromeInstance;
}

function harness(options: Partial<ConstructorParameters<typeof BrowserRuntime>[0]> = {}): Harness {
  const clock = new FakeClock();
  const browser = new FakeBrowser();
  const ensureCalls: string[] = [];
  const state = { closedBrowsers: 0 };
  const profile: ProfileInfo = {
    key: "shared",
    userDataDir: "/tmp/profile",
    label: "shared",
    persistent: true,
  };
  const instance: ChromeInstance = {
    pid: 100,
    port: 9222,
    wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/x",
    userDataDir: profile.userDataDir,
    executablePath: "/usr/bin/chrome",
    startedAt: "2026-11-20T00:00:00.000Z",
    ownerSessionId: "first",
  };
  const runtime = new BrowserRuntime({
    agentDir: "/tmp/agent",
    cwd: "/tmp",
    config: {
      profile: "shared",
      headless: true,
      viewport: { width: 1280, height: 800 },
      stealth: "basic",
      noSandbox: false,
      args: [],
    },
    attach: true,
    maxPages: 4,
    maxTabsPerSession: 8,
    clock,
    ensure: async (request) => {
      ensureCalls.push(request.sessionId);
      return { instance, profile, attached: false };
    },
    connect: async () => browser,
    closeBrowser: async () => {
      state.closedBrowsers++;
    },
    ...options,
  });
  return {
    runtime,
    clock,
    browser,
    ensureCalls,
    closedBrowsers: state.closedBrowsers,
    profile,
    instance,
  };
}

describe("BrowserRuntime", () => {
  it("shares one process between two sessions", async () => {
    const test = harness();
    const first = await test.runtime.acquire("a");
    const second = await test.runtime.acquire("b");
    expect(second.browser).toBe(first.browser);
    expect(test.ensureCalls).toEqual(["a"]);
    await test.runtime.releaseAll();
  });

  it("keeps an attached browser running when a session leaves", async () => {
    let closed = 0;
    const test = harness({
      ensure: async () => ({
        instance: {
          pid: 7,
          port: 9222,
          wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/x",
          userDataDir: "/tmp/profile",
          executablePath: "/usr/bin/chrome",
          startedAt: "2026-11-20T00:00:00.000Z",
          ownerSessionId: "other-process",
        },
        profile: {
          key: "shared",
          userDataDir: "/tmp/profile",
          label: "shared",
          persistent: true,
        },
        attached: true,
      }),
      closeBrowser: async () => {
        closed++;
      },
    });
    await test.runtime.acquire("a");
    await test.runtime.release("a");
    expect(closed).toBe(0);
    expect(test.browser.closed).toBe(false);
  });

  it("closes a browser this process launched when the last lease leaves", async () => {
    let closed = 0;
    const test = harness({
      closeBrowser: async () => {
        closed++;
      },
    });
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    await test.runtime.release("a");
    expect(closed).toBe(0);
    await test.runtime.release("b");
    expect(closed).toBe(1);
  });

  it("keeps tabs private to the session that opened them", async () => {
    const test = harness();
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    const pageOfA = await test.runtime.createPage("a");

    expect(test.runtime.visible("a", pageOfA)).toBe(true);
    expect(test.runtime.visible("b", pageOfA)).toBe(false);
    expect(test.runtime.owns("b", pageOfA)).toBe(false);
    expect(test.runtime.claim("b", pageOfA)).toBe(false);

    const pageOfB = await test.runtime.createPage("b");
    expect(test.runtime.visible("a", pageOfB)).toBe(false);
    expect(await test.runtime.sessionPages("a")).toEqual([pageOfA]);
    expect(await test.runtime.sessionPages("b")).toEqual([pageOfB]);
    await test.runtime.releaseAll();
  });

  it("lets every session see a page nobody claimed", async () => {
    const test = harness();
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    const page = new FakePage();
    expect(test.runtime.visible("a", page)).toBe(true);
    expect(test.runtime.visible("b", page)).toBe(true);
    expect(test.runtime.claim("b", page)).toBe(true);
    expect(test.runtime.visible("a", page)).toBe(false);
    await test.runtime.releaseAll();
  });

  it("closes only the leaving session's pages", async () => {
    const test = harness();
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    const pageOfA = await test.runtime.createPage("a");
    const pageOfB = await test.runtime.createPage("b");
    await test.runtime.release("a");
    expect(pageOfA.isClosed()).toBe(true);
    expect(pageOfB.isClosed()).toBe(false);
    await test.runtime.releaseAll();
  });

  it("enforces the per-session tab cap", async () => {
    const test = harness({ maxTabsPerSession: 1 });
    await test.runtime.acquire("a");
    await test.runtime.createPage("a");
    await expect(test.runtime.createPage("a")).rejects.toBeInstanceOf(TabLimitError);
    await test.runtime.releaseAll();
  });

  it("enforces the per-session tab rate", async () => {
    const test = harness({ maxTabsPerSession: 8, tabsPerMinutePerSession: 1 });
    await test.runtime.acquire("a");
    await test.runtime.createPage("a");
    await expect(test.runtime.createPage("a")).rejects.toBeInstanceOf(TabLimitError);
    test.clock.advanceBy(61_000);
    await expect(test.runtime.createPage("a")).resolves.toBeDefined();
    await test.runtime.releaseAll();
  });

  it("enforces the global tab rate across sessions", async () => {
    const test = harness({ tabsPerMinuteGlobal: 1 });
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    await test.runtime.createPage("a");
    await expect(test.runtime.createPage("b")).rejects.toBeInstanceOf(TabLimitError);
    await test.runtime.releaseAll();
  });

  it("queues pages fairly when the pool is full", async () => {
    const test = harness({ maxPages: 1 });
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    const pageOfA = await test.runtime.createPage("a");

    let gotB = false;
    const pending = test.runtime.createPage("b").then((page) => {
      gotB = true;
      return page;
    });
    await flush();
    expect(gotB).toBe(false);

    await test.runtime.closePage("a", pageOfA);
    const pageOfB = await pending;
    expect(gotB).toBe(true);
    expect(pageOfB).toBeDefined();
    await test.runtime.releaseAll();
  });

  it("returns a page's pool slot when the browser closed it", async () => {
    const test = harness({ maxPages: 1 });
    await test.runtime.acquire("a");
    const page = (await test.runtime.createPage("a")) as FakePage;
    page.closed = true;
    const replacement = await test.runtime.createPage("a");
    expect(replacement).toBeDefined();
    await test.runtime.releaseAll();
  });

  it("closes only the calling session while another session leases the browser", async () => {
    let closed = 0;
    const test = harness({
      closeBrowser: async () => {
        closed++;
      },
    });
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    const pageOfB = await test.runtime.createPage("b");
    const result = await test.runtime.closeBrowser("a");
    expect(result.sharedWith).toEqual(["b"]);
    expect(closed).toBe(0);
    expect(pageOfB.isClosed()).toBe(false);
    expect(await test.runtime.sessionPages("b")).toEqual([pageOfB]);
    await test.runtime.releaseAll();
    expect(closed).toBe(1);
  });

  it("closes the browser after the other session leaves", async () => {
    let closed = 0;
    const test = harness({
      closeBrowser: async () => {
        closed++;
      },
    });
    await test.runtime.acquire("a");
    await test.runtime.acquire("b");
    await test.runtime.release("b");
    await test.runtime.closeBrowser("a");
    expect(closed).toBe(1);
  });

  it("gives a contexts session its own cookie jar", async () => {
    const test = harness();
    await test.runtime.acquire("a", { isolation: "contexts" });
    expect(test.browser.contexts).toBe(1);
    const page = await test.runtime.createPage("a");
    expect(test.browser.pagesList).toContain(page);
    await test.runtime.releaseAll();
  });

  it("hands out a session handle bound to one id", async () => {
    const test = harness();
    const handle = await test.runtime.openSession("a", { isolation: "tabs" });
    expect(handle.id).toBe("a");
    expect(handle.isolation).toBe("tabs");
    const page = await handle.createPage();
    expect(handle.owns(page)).toBe(true);
    expect(handle.visible(page)).toBe(true);
    expect(await handle.pages()).toEqual([page]);
    await handle.closePage(page);
    expect(page.isClosed()).toBe(true);
    await handle.close();
    expect(await handle.pages()).toEqual([]);
  });

  it("paces navigations through the shared host budget", async () => {
    const calls: Array<{ host: string; minIntervalMs?: number }> = [];
    const test = harness({
      navigation: {
        limiter: {
          schedule: async (
            request: { host: string; minIntervalMs?: number },
            task: () => Promise<unknown>,
          ) => {
            calls.push({ host: request.host, minIntervalMs: request.minIntervalMs });
            return task();
          },
        } as never,
        store: { intervalMs: () => 500 } as never,
      },
    });
    await test.runtime.beforeNavigation("https://example.com/page");
    expect(calls).toEqual([{ host: "example.com", minIntervalMs: 500 }]);
    await test.runtime.beforeNavigation("not a url");
    expect(calls.length).toBe(1);
  });

  it("rejects work for a session that was never acquired", async () => {
    const test = harness();
    await expect(test.runtime.createPage("ghost")).rejects.toThrow(/No browser session/);
    expect(() => test.runtime.claim("ghost", new FakePage())).not.toThrow();
    expect(test.runtime.claim("ghost", new FakePage())).toBe(false);
  });
});

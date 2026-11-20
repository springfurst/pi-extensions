import { describe, expect, it } from "vitest";
import { DEFAULT_POLITENESS_CONFIG, type HostPolicy, type PolitenessConfig } from "./config";
import { RequestLimiter } from "./limiter";
import { HostStateStore, type Politeness } from "./politeness";
import { RobotsCache } from "./robots";
import { DEFAULT_USER_AGENT } from "./user-agent";
import { startServer } from "./__fixtures__/server";
import { transfer } from "./transfer";

function politeness(
  overrides: Partial<PolitenessConfig> = {},
  hosts: Record<string, HostPolicy> = {},
): Politeness {
  const config = { ...DEFAULT_POLITENESS_CONFIG, ...overrides };
  return {
    config,
    hosts,
    store: new HostStateStore({ hosts, latencyWarningFactor: config.latencyWarningFactor }),
    limiter: new RequestLimiter({
      globalConcurrency: config.globalConcurrency,
      globalRequestsPerSecond: config.globalRequestsPerSecond,
      jitterFraction: 0,
    }),
    robots: new RobotsCache(),
  };
}

async function robotsServer(body: string) {
  const seen: string[] = [];
  const server = await startServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/robots.txt") {
      res.setHeader("Content-Type", "text/plain");
      res.end(body);
      return;
    }
    res.end("page");
  });
  return { server, seen };
}

describe("transfer", () => {
  it("fetches a body and content type", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello");
    });
    try {
      const result = await transfer(`${server.origin}/`, { allowPrivateHosts: true });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("hello");
      expect(result.contentType).toBe("text/plain");
      expect(result.finalUrl).toBe(`${server.origin}/`);
    } finally {
      await server.close();
    }
  });

  it("decodes a declared non-UTF-8 charset", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=iso-8859-1");
      res.end(Buffer.from("café", "latin1"));
    });
    try {
      const result = await transfer(`${server.origin}/`, { allowPrivateHosts: true });
      expect(result.content).toBe("café");
    } finally {
      await server.close();
    }
  });

  it("follows redirects manually", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/end" });
        res.end();
        return;
      }
      res.end("arrived");
    });
    try {
      const result = await transfer(`${server.origin}/start`, { allowPrivateHosts: true });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("arrived");
      expect(result.finalUrl).toBe(`${server.origin}/end`);
    } finally {
      await server.close();
    }
  });

  it("stops after the redirect cap", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(302, { Location: "/loop" });
      res.end();
    });
    try {
      const result = await transfer(`${server.origin}/loop`, { allowPrivateHosts: true });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/redirect/i);
    } finally {
      await server.close();
    }
  });

  it("retries once on 429", async () => {
    let requests = 0;
    const server = await startServer((_req, res) => {
      requests++;
      if (requests === 1) {
        res.writeHead(429, { "Retry-After": "0" });
        res.end("slow down");
        return;
      }
      res.end("ok");
    });
    try {
      const result = await transfer(`${server.origin}/`, { allowPrivateHosts: true });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("ok");
      expect(requests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("sends one honest user agent and does not rotate on a 403", async () => {
    const seen: string[] = [];
    const server = await startServer((req, res) => {
      seen.push(req.headers["user-agent"] ?? "");
      res.writeHead(403);
      res.end("blocked");
    });
    try {
      const result = await transfer(`${server.origin}/`, { allowPrivateHosts: true });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
      expect(seen).toEqual([DEFAULT_USER_AGENT]);
    } finally {
      await server.close();
    }
  });

  it("sends the configured identity and contact", async () => {
    let userAgent: string | undefined;
    let from: string | undefined;
    const server = await startServer((req, res) => {
      userAgent = req.headers["user-agent"];
      from = req.headers["from"];
      res.end("ok");
    });
    try {
      const result = await transfer(`${server.origin}/`, {
        allowPrivateHosts: true,
        politeness: politeness({ userAgent: "my-bot/2.0", contact: "ops@example.org" }),
      });
      expect(result.ok).toBe(true);
      expect(userAgent).toBe("my-bot/2.0");
      expect(from).toBe("ops@example.org");
    } finally {
      await server.close();
    }
  });

  it("refuses a disallowed path under robots strict", async () => {
    const { server, seen } = await robotsServer("User-agent: *\nDisallow: /private\n");
    try {
      const result = await transfer(`${server.origin}/private/secret`, {
        allowPrivateHosts: true,
        politeness: politeness({ robots: "strict" }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/robots\.txt disallows \/private\/secret/);
      expect(seen).toEqual(["/robots.txt"]);
    } finally {
      await server.close();
    }
  });

  it("fetches a disallowed path under robots warn and reports it once", async () => {
    const { server } = await robotsServer("User-agent: *\nDisallow: /private\n");
    try {
      const policy = politeness({ robots: "warn" });
      const first = await transfer(`${server.origin}/private/secret`, {
        allowPrivateHosts: true,
        politeness: policy,
      });
      expect(first.ok).toBe(true);
      expect(first.content).toBe("page");
      expect(first.notes?.join("\n")).toMatch(/robots\.txt disallows/);

      const second = await transfer(`${server.origin}/private/other`, {
        allowPrivateHosts: true,
        politeness: policy,
      });
      expect(second.ok).toBe(true);
      expect(second.notes).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("fails fast when Retry-After is longer than the wait cap", async () => {
    let requests = 0;
    const server = await startServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.end("User-agent: *\n");
        return;
      }
      requests++;
      res.writeHead(429, { "Retry-After": "3600" });
      res.end("later");
    });
    try {
      const started = Date.now();
      const result = await transfer(`${server.origin}/`, {
        allowPrivateHosts: true,
        politeness: politeness({ maxRetryWaitSeconds: 30 }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/wait cap/);
      expect(result.error).toMatch(/1 hour/);
      expect(result.retryAfterMs).toBe(3_600_000);
      expect(requests).toBe(1);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });

  it("waits out a short Retry-After and retries once", async () => {
    let requests = 0;
    const server = await startServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.end("User-agent: *\n");
        return;
      }
      requests++;
      if (requests === 1) {
        res.writeHead(429, { "Retry-After": "0" });
        res.end("slow down");
        return;
      }
      res.end("ok");
    });
    try {
      const result = await transfer(`${server.origin}/`, {
        allowPrivateHosts: true,
        politeness: politeness({}, {}),
      });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("ok");
      expect(requests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("reports a challenge without escalating", async () => {
    let requests = 0;
    const server = await startServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.end("User-agent: *\n");
        return;
      }
      requests++;
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end("<html><title>Just a moment...</title><div id='challenge-platform'></div></html>");
    });
    try {
      const result = await transfer(`${server.origin}/`, {
        allowPrivateHosts: true,
        politeness: politeness(),
      });
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("challenge");
      expect(result.challenge?.type).toBe("cloudflare");
      expect(result.error).toMatch(/challenge detected/);
      expect(requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("spaces repeat requests to one host", async () => {
    const arrivals: number[] = [];
    const server = await startServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.end("User-agent: *\n");
        return;
      }
      arrivals.push(Date.now());
      res.end("ok");
    });
    try {
      const policy = politeness({}, { [new URL(server.origin).host]: { minIntervalMs: 120 } });
      await transfer(`${server.origin}/`, { allowPrivateHosts: true, politeness: policy });
      const first = arrivals[0]!;
      await transfer(`${server.origin}/`, { allowPrivateHosts: true, politeness: policy });
      expect(arrivals.length).toBe(2);
      expect(arrivals[1]! - first).toBeGreaterThanOrEqual(100);
    } finally {
      await server.close();
    }
  });

  it("cuts a body at the byte cap", async () => {
    const server = await startServer((_req, res) => {
      res.end("0123456789");
    });
    try {
      const result = await transfer(`${server.origin}/`, { allowPrivateHosts: true, maxBytes: 4 });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("0123");
      expect(result.truncated).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("drops credentials on a cross-origin redirect", async () => {
    let received: string | undefined;
    const target = await startServer((req, res) => {
      received = req.headers["authorization"];
      res.end("ok");
    });
    const source = await startServer((_req, res) => {
      res.writeHead(302, { Location: `${target.origin}/` });
      res.end();
    });
    try {
      const result = await transfer(`${source.origin}/`, {
        allowPrivateHosts: true,
        headers: { Authorization: "Bearer secret" },
      });
      expect(result.ok).toBe(true);
      expect(received).toBeUndefined();
    } finally {
      await source.close();
      await target.close();
    }
  });

  it("keeps credentials on a same-origin redirect", async () => {
    let received: string | undefined;
    const server = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/end" });
        res.end();
        return;
      }
      received = req.headers["authorization"];
      res.end("ok");
    });
    try {
      const result = await transfer(`${server.origin}/start`, {
        allowPrivateHosts: true,
        headers: { Authorization: "Bearer secret" },
      });
      expect(result.ok).toBe(true);
      expect(received).toBe("Bearer secret");
    } finally {
      await server.close();
    }
  });

  it("blocks loopback unless private hosts are allowed", async () => {
    const server = await startServer((_req, res) => {
      res.end("secret");
    });
    try {
      const blocked = await transfer(`${server.origin}/`);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/Blocked private address/);
    } finally {
      await server.close();
    }
  });
});

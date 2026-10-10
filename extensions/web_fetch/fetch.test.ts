import { describe, expect, it } from "vitest";
import { startServer } from "./__fixtures__/test-server";
import { loadPage } from "./fetch";

describe("loadPage", () => {
  it("fetches a body and content type", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello");
    });
    try {
      const result = await loadPage(`${server.origin}/`, { allowPrivateHosts: true });
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
      const result = await loadPage(`${server.origin}/`, { allowPrivateHosts: true });
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
      const result = await loadPage(`${server.origin}/start`, { allowPrivateHosts: true });
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
      const result = await loadPage(`${server.origin}/loop`, { allowPrivateHosts: true });
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
      const result = await loadPage(`${server.origin}/`, { allowPrivateHosts: true });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("ok");
      expect(requests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("cuts a body at the byte cap", async () => {
    const server = await startServer((_req, res) => {
      res.end("0123456789");
    });
    try {
      const result = await loadPage(`${server.origin}/`, { allowPrivateHosts: true, maxBytes: 4 });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("0123");
      expect(result.truncated).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("blocks loopback unless private hosts are allowed", async () => {
    const server = await startServer((_req, res) => {
      res.end("secret");
    });
    try {
      const blocked = await loadPage(`${server.origin}/`);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/Blocked private address/);
    } finally {
      await server.close();
    }
  });
});

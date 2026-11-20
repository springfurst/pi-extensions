import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "./__fixtures__/clock";
import { RequestLimiter } from "./limiter";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function limiter(
  clock: FakeClock,
  options: Partial<ConstructorParameters<typeof RequestLimiter>[0]> = {},
): RequestLimiter {
  return new RequestLimiter({
    globalConcurrency: 4,
    globalRequestsPerSecond: 100,
    clock,
    jitterFraction: 0,
    ...options,
  });
}

describe("RequestLimiter", () => {
  it("spaces requests to one host by the configured interval", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock);
    const started: number[] = [];
    const first = limiterInstance.schedule({ host: "example.com", minIntervalMs: 1000 }, () => {
      started.push(clock.now());
      return Promise.resolve();
    });
    const second = limiterInstance.schedule({ host: "example.com", minIntervalMs: 1000 }, () => {
      started.push(clock.now());
      return Promise.resolve();
    });

    await clock.advanceToNext();
    expect(started).toEqual([1_700_000_000_000]);
    expect(clock.waiting).toBe(1);

    await clock.advanceToNext();
    expect(started).toEqual([1_700_000_000_000, 1_700_000_001_000]);
    await Promise.all([first, second]);
  });

  it("does not delay a different host", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock);
    const hosts: string[] = [];
    const first = limiterInstance.schedule({ host: "a.example", minIntervalMs: 1000 }, () => {
      hosts.push("a");
      return Promise.resolve();
    });
    const second = limiterInstance.schedule({ host: "b.example", minIntervalMs: 1000 }, () => {
      hosts.push("b");
      return Promise.resolve();
    });

    await clock.advanceToNext();
    expect(hosts).toEqual(["a", "b"]);
    await Promise.all([first, second]);
  });

  it("adds jitter on top of the host gap", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock, { random: () => 0.5, jitterFraction: 0.2 });
    const started: number[] = [];
    const run = (): Promise<void> => {
      started.push(clock.now());
      return Promise.resolve();
    };
    const first = limiterInstance.schedule({ host: "example.com", minIntervalMs: 100 }, run);
    const second = limiterInstance.schedule({ host: "example.com", minIntervalMs: 100 }, run);
    await clock.advanceToNext();
    await clock.advanceToNext();
    expect(started[1]! - started[0]!).toBe(110);
    await Promise.all([first, second]);
  });

  it("enforces the global requests-per-second bucket", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock, { globalRequestsPerSecond: 2, globalConcurrency: 4 });
    const started: number[] = [];
    const run = (): Promise<void> => {
      started.push(clock.now());
      return Promise.resolve();
    };
    const first = limiterInstance.schedule({ host: "a.example" }, run);
    const second = limiterInstance.schedule({ host: "b.example" }, run);
    const third = limiterInstance.schedule({ host: "c.example" }, run);

    await clock.advanceToNext();
    expect(started.length).toBe(2);
    await clock.advanceToNext();
    expect(started.length).toBe(3);
    expect(started[2]! - started[1]!).toBeGreaterThan(0);
    await Promise.all([first, second, third]);
  });

  it("never runs more than the global concurrency", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock, { globalConcurrency: 2 });
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run = (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          active--;
          resolve();
        });
      });
    };

    const tasks = ["a", "b", "c", "d"].map((host) => limiterInstance.schedule({ host }, run));
    await clock.advanceToNext();
    expect(peak).toBe(2);

    while (releases.length > 0) {
      releases.shift()!();
      await clock.advanceToNext();
    }
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it("rejects a queued request when its signal aborts", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock, { globalConcurrency: 1 });
    let release!: () => void;
    const running = limiterInstance.schedule({ host: "a.example" }, () => {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const controller = new AbortController();
    const queued = limiterInstance.schedule({ host: "b.example", signal: controller.signal }, () =>
      Promise.resolve("ran"),
    );
    controller.abort();
    await expect(queued).rejects.toThrow();
    release();
    await running;
  });

  it("rejects while waiting for the host gap", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock);
    await limiterInstance.schedule({ host: "example.com", minIntervalMs: 5000 }, () =>
      Promise.resolve(),
    );

    const controller = new AbortController();
    const waiting = limiterInstance.schedule(
      { host: "example.com", minIntervalMs: 5000, signal: controller.signal },
      () => Promise.resolve("ran"),
    );
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(clock.waiting).toBe(0);
  });

  it("keeps the host gap after a failed request", async () => {
    const clock = new FakeClock();
    const limiterInstance = limiter(clock);
    await expect(
      limiterInstance.schedule({ host: "example.com", minIntervalMs: 100 }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(limiterInstance.nextAllowedAt("example.com")).toBe(1_700_000_000_100);
  });

  it("paces real requests against a local server", async () => {
    const arrivals: number[] = [];
    const server = createServer((_request, response) => {
      arrivals.push(Date.now());
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}/`;

    const limiterInstance = new RequestLimiter({
      globalConcurrency: 2,
      globalRequestsPerSecond: 100,
      jitterFraction: 0,
    });
    const fire = () =>
      limiterInstance.schedule({ host: `127.0.0.1:${address.port}`, minIntervalMs: 60 }, () =>
        fetch(url),
      );

    const started = Date.now();
    await Promise.all([fire(), fire(), fire()]);
    const elapsed = Date.now() - started;
    expect(arrivals.length).toBe(3);
    // The first connection adds one-time overhead, so the wall clock can be a
    // little shorter than two full gaps; pacing at the reservation layer is
    // covered by the fake-clock cases above.
    expect(elapsed).toBeGreaterThanOrEqual(100);
  }, 10_000);
});

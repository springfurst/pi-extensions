import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "./__fixtures__/clock";
import {
  CURATED_INTERVALS,
  DEFAULT_HOST_INTERVAL_MS,
  HostStateStore,
  findHostPolicy,
  resetSharedPoliteness,
  sharedPoliteness,
} from "./politeness";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-politeness-"));
  roots.push(dir);
  return dir;
}

function store(options: Partial<ConstructorParameters<typeof HostStateStore>[0]> = {}) {
  const clock = options.clock ?? new FakeClock();
  return {
    clock,
    state: new HostStateStore({ clock, curated: CURATED_INTERVALS, ...options }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetSharedPoliteness();
});

describe("host policy resolution", () => {
  it("applies a parent-domain policy to subdomains", () => {
    const hosts = { "github.com": { robots: "strict" as const } };
    expect(findHostPolicy("github.com", hosts)).toEqual({ robots: "strict" });
    expect(findHostPolicy("api.github.com", hosts)).toEqual({ robots: "strict" });
    expect(findHostPolicy("notgithub.com", hosts)).toBeUndefined();
  });

  it("prefers an exact host over its parent", () => {
    const hosts = {
      "github.com": { minIntervalMs: 500 },
      "api.github.com": { minIntervalMs: 100 },
    };
    expect(findHostPolicy("api.github.com", hosts)?.minIntervalMs).toBe(100);
  });

  it("matches a host that carries a port", () => {
    expect(findHostPolicy("localhost:3000", { "localhost:3000": { robots: "strict" } })).toEqual({
      robots: "strict",
    });
  });
});

describe("HostStateStore", () => {
  it("uses curated values, including for subdomains", () => {
    const { state } = store();
    expect(state.baseIntervalMs("arxiv.org")).toBe(3_000);
    expect(state.baseIntervalMs("export.arxiv.org")).toBe(3_000);
    expect(state.baseIntervalMs("unknown.test")).toBe(DEFAULT_HOST_INTERVAL_MS);
  });

  it("lets a configured minimum interval replace the curated value", () => {
    const { state } = store({ hosts: { "arxiv.org": { minIntervalMs: 5_000 } } });
    expect(state.baseIntervalMs("arxiv.org")).toBe(5_000);
    expect(state.baseIntervalMs("export.arxiv.org")).toBe(5_000);
  });

  it("multiplies the gap on a block and clamps it to 4x the base", () => {
    const { state } = store({ hosts: { "example.com": { minIntervalMs: 100 } } });
    expect(state.noteThrottle("example.com")).toBe(200);
    expect(state.noteThrottle("example.com")).toBe(400);
    expect(state.noteThrottle("example.com")).toBe(400);
    expect(state.intervalMs("example.com")).toBe(400);
  });

  it("remembers Retry-After on the host", () => {
    const clock = new FakeClock();
    const { state } = store({ clock, hosts: { "example.com": { minIntervalMs: 100 } } });
    state.noteThrottle("example.com", 30_000);
    expect(state.remainingBlockMs("example.com")).toBe(30_000);
    clock.advanceBy(10_000);
    expect(state.remainingBlockMs("example.com")).toBe(20_000);
    clock.advanceBy(60_000);
    expect(state.remainingBlockMs("example.com")).toBe(0);
  });

  it("decays the gap on successes, down to half the base", () => {
    const { state } = store({ hosts: { "example.com": { minIntervalMs: 100 } } });
    state.noteThrottle("example.com");
    state.noteThrottle("example.com");
    expect(state.intervalMs("example.com")).toBe(400);
    state.noteSuccess("example.com", 50);
    expect(state.intervalMs("example.com")).toBe(390);
    for (let index = 0; index < 100; index++) state.noteSuccess("example.com", 50);
    expect(state.intervalMs("example.com")).toBe(50);
  });

  it("raises one notch when latency stays above the baseline", () => {
    const { state } = store({
      hosts: { "example.com": { minIntervalMs: 200 } },
      latencyWarningFactor: 2,
      decayStepMs: 0,
    });
    expect(state.noteSuccess("example.com", 100).warningRaised).toBe(false);
    expect(state.noteSuccess("example.com", 100).warningRaised).toBe(false);
    const warned = state.noteSuccess("example.com", 500);
    expect(warned.warningRaised).toBe(true);
    expect(warned.intervalMs).toBe(250);
    expect(state.snapshot().hosts["example.com"]?.latencyWarning).toBe(true);
  });

  it("learns faster on the next block after a latency warning", () => {
    const { state } = store({
      hosts: { "example.com": { minIntervalMs: 200 } },
      latencyWarningFactor: 2,
      decayStepMs: 0,
    });
    state.noteSuccess("example.com", 100);
    state.noteSuccess("example.com", 100);
    state.noteSuccess("example.com", 500);
    expect(state.intervalMs("example.com")).toBe(250);
    expect(state.noteThrottle("example.com")).toBe(800);
    expect(state.snapshot().hosts["example.com"]?.latencyWarning).toBe(false);
  });

  it("ignores a single slow sample", () => {
    const { state } = store({
      hosts: { "example.com": { minIntervalMs: 100 } },
      decayStepMs: 0,
    });
    expect(state.noteSuccess("example.com", 10_000).warningRaised).toBe(false);
    expect(state.intervalMs("example.com")).toBe(100);
  });

  it("resets learned values after the time-to-live", () => {
    const clock = new FakeClock();
    const { state: hostState } = store({
      clock,
      hosts: { "example.com": { minIntervalMs: 100 } },
      ttlMs: 1_000,
    });
    hostState.noteThrottle("example.com");
    expect(hostState.intervalMs("example.com")).toBe(200);
    clock.advanceBy(1_500);
    expect(hostState.intervalMs("example.com")).toBe(100);
  });

  it("persists learned state across a restart", () => {
    const dir = tempDir();
    const path = join(dir, "web-tools", "host-state.json");
    const clock = new FakeClock();
    const first = new HostStateStore({
      path,
      clock,
      hosts: { "example.com": { minIntervalMs: 100 } },
    });
    first.noteThrottle("example.com");
    first.save();

    const reloaded = new HostStateStore({
      path,
      clock,
      hosts: { "example.com": { minIntervalMs: 100 } },
    });
    expect(reloaded.intervalMs("example.com")).toBe(200);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.schema).toBe(1);
    expect(written.hosts["example.com"].intervalMs).toBe(200);
  });

  it("starts clean when the state file is malformed", () => {
    const path = join(tempDir(), "host-state.json");
    writeFileSync(path, "{ not json");
    const state = new HostStateStore({ path, curated: {}, hosts: {} });
    expect(state.snapshot().hosts).toEqual({});
  });

  it("drops malformed host entries", () => {
    const path = join(tempDir(), "host-state.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        hosts: {
          "good.test": { intervalMs: 500, updatedAt: 1_700_000_000_000 },
          "negative.test": { intervalMs: -1, updatedAt: 1_700_000_000_000 },
          "no-date.test": { intervalMs: 100 },
        },
      }),
    );
    const state = new HostStateStore({ path, curated: {}, hosts: {} });
    expect(Object.keys(state.snapshot().hosts)).toEqual(["good.test"]);
  });

  it("keeps working when the state file cannot be written", () => {
    const dir = tempDir();
    const path = join(dir, "blocked", "host-state.json");
    mkdirSync(join(dir, "blocked"), { recursive: true });
    // A directory where the file should go makes the rename fail.
    mkdirSync(path);
    const clock = new FakeClock();
    const state = new HostStateStore({
      path,
      clock,
      hosts: { "example.com": { minIntervalMs: 100 } },
    });
    expect(() => state.noteThrottle("example.com")).not.toThrow();
    expect(state.intervalMs("example.com")).toBe(200);
  });
});

describe("sharedPoliteness", () => {
  const politeness = {
    robots: "warn" as const,
    tier: "polite" as const,
    evasion: "off" as const,
    human: "hint" as const,
    globalConcurrency: 4,
    globalRequestsPerSecond: 8,
    latencyWarningFactor: 2,
    maxRetryWaitSeconds: 30,
  };

  it("shares one limiter and store per directory", () => {
    const dir = tempDir();
    const first = sharedPoliteness({ dir, politeness });
    const second = sharedPoliteness({ dir, politeness });
    expect(second.limiter).toBe(first.limiter);
    expect(second.store).toBe(first.store);
  });

  it("keeps host gaps between callers of the shared limiter", async () => {
    const dir = tempDir();
    const clock = new FakeClock();
    const shared = sharedPoliteness({ dir, politeness, clock });
    await shared.limiter.schedule({ host: "example.com", minIntervalMs: 1_000 }, () =>
      Promise.resolve(),
    );
    const next = shared.limiter.nextAllowedAt("example.com");
    expect(next).toBeGreaterThanOrEqual(clock.now() + 1_000);
    expect(next).toBeLessThanOrEqual(clock.now() + 1_150);
  });

  it("exposes per-host policy from configuration", () => {
    const dir = tempDir();
    const shared = sharedPoliteness({
      dir,
      politeness,
      hosts: { "github.com": { robots: "strict", minIntervalMs: 2_000 } },
    });
    expect(shared.store.policyFor("api.github.com")).toEqual({
      robots: "strict",
      minIntervalMs: 2_000,
    });
    expect(shared.store.baseIntervalMs("api.github.com")).toBe(2_000);
  });
});

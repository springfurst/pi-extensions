/**
 * Request pacing for every outbound web call.
 *
 * Two budgets apply to each request: a global token bucket (requests per
 * second across all hosts) plus a global concurrency cap, and a per-host
 * minimum gap. Host gaps come from configuration, robots `Crawl-delay`, and the
 * learned limits in `politeness.ts`; this module only enforces them.
 */

import { abortReason, systemClock, type Clock } from "./clock";

export interface RequestLimiterOptions {
  /** Requests in flight across every host. */
  globalConcurrency: number;
  /** Requests per second across every host; also sets the bucket burst. */
  globalRequestsPerSecond: number;
  clock?: Clock;
  /** Fraction of the host gap added as jitter to avoid lockstep requests. */
  jitterFraction?: number;
  /** Random source in `[0, 1)`; injectable so tests stay deterministic. */
  random?: () => number;
}

export interface LimiterRequest {
  /** Host or origin that owns the per-host gap. */
  host: string;
  /** Minimum gap since the previous request to the same host, in milliseconds. */
  minIntervalMs?: number;
  signal?: AbortSignal;
}

interface SlotWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Run work under the global and per-host budgets. */
export class RequestLimiter {
  private readonly clock: Clock;
  private readonly maxConcurrency: number;
  private readonly requestsPerSecond: number;
  private readonly capacity: number;
  private readonly jitterFraction: number;
  private readonly random: () => number;

  private active = 0;
  private readonly waiters: SlotWaiter[] = [];
  private tokens: number;
  private lastRefill: number;
  private readonly hostNextAt = new Map<string, number>();

  constructor(options: RequestLimiterOptions) {
    this.clock = options.clock ?? systemClock;
    this.maxConcurrency = Math.max(1, options.globalConcurrency);
    this.requestsPerSecond = Math.max(0.001, options.globalRequestsPerSecond);
    this.capacity = Math.max(1, this.requestsPerSecond);
    this.jitterFraction = Math.min(1, Math.max(0, options.jitterFraction ?? 0.15));
    this.random = options.random ?? Math.random;
    this.tokens = this.capacity;
    this.lastRefill = this.clock.now();
  }

  /**
   * Wait for a concurrency slot, a global token, and the host gap, then run
   * `task`. The slot is released even when the task throws or aborts.
   */
  async schedule<T>(request: LimiterRequest, task: () => Promise<T>): Promise<T> {
    request.signal?.throwIfAborted();
    await this.acquireSlot(request.signal);
    try {
      await this.reserve(request);
      return await task();
    } finally {
      this.releaseSlot();
    }
  }

  /** The earliest time the given host may be contacted again. */
  nextAllowedAt(host: string): number {
    return this.hostNextAt.get(host) ?? 0;
  }

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.active = Math.max(0, this.active - 1);
        return;
      }
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      // The freed slot transfers directly to the next waiter.
      waiter.resolve();
      return;
    }
  }

  private async reserve(request: LimiterRequest): Promise<void> {
    const host = request.host;
    const interval = Math.max(0, request.minIntervalMs ?? 0);
    for (;;) {
      request.signal?.throwIfAborted();
      const now = this.clock.now();
      this.refill(now);
      const hostWait = Math.max(0, (this.hostNextAt.get(host) ?? 0) - now);
      const tokenWait =
        this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.requestsPerSecond) * 1000);
      const wait = Math.max(hostWait, tokenWait);
      if (wait <= 0) {
        this.tokens = Math.max(0, this.tokens - 1);
        const jitter = interval > 0 ? interval * this.jitterFraction * this.random() : 0;
        this.hostNextAt.set(host, now + interval + jitter);
        return;
      }
      await this.clock.sleep(wait, request.signal);
    }
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.requestsPerSecond);
    this.lastRefill = now;
  }
}

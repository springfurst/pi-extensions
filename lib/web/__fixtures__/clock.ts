/**
 * A clock whose sleeps only end when the test advances time.
 *
 * Time is monotonic and starts at zero. `advanceToNext` moves to the earliest
 * pending wake so a scheduler loop can settle one step at a time; `advanceBy`
 * is for asserting that nothing happens before a deadline.
 */

import { abortReason, type Clock } from "../clock";

interface PendingSleep {
  at: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class FakeClock implements Clock {
  private time = 0;
  private pending: PendingSleep[] = [];

  /** Start the clock at a fixed epoch so HTTP-date parsing stays readable. */
  constructor(start = 1_700_000_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const entry: PendingSleep = { at: this.time + ms, resolve, reject };
      const onAbort = () => {
        this.pending = this.pending.filter((item) => item !== entry);
        reject(abortReason(signal));
      };
      this.pending.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = entry.resolve;
      entry.resolve = () => {
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
    });
  }

  /** Wake every sleep due at the earliest deadline and let continuations run. */
  async advanceToNext(): Promise<void> {
    if (this.pending.length === 0) {
      await flush();
      return;
    }
    const at = Math.min(...this.pending.map((entry) => entry.at));
    this.time = Math.max(this.time, at);
    const due = this.pending.filter((entry) => entry.at <= this.time);
    this.pending = this.pending.filter((entry) => entry.at > this.time);
    for (const entry of due) entry.resolve();
    await flush();
  }

  /** Move time forward, waking anything that becomes due. */
  async advanceBy(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = this.pending
        .filter((entry) => entry.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      await this.advanceToNext();
    }
    this.time = Math.max(this.time, target);
    await flush();
  }

  /** Number of waits still pending. */
  get waiting(): number {
    return this.pending.length;
  }
}

/** Let queued microtasks, promise continuations, and timers settle. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

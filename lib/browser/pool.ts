/**
 * A page pool with fair per-session queueing.
 *
 * The pool bounds how many pages may be open across every session sharing one
 * browser. Waiting sessions take turns: a session that keeps asking cannot
 * starve the others, because the queue rotates by session rather than by
 * request.
 */

import { abortReason } from "../web/clock";

export interface PagePoolOptions {
  /** Open pages allowed across all sessions. */
  maxPages: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class PagePool {
  private readonly maxPages: number;
  private active = 0;
  private readonly queues = new Map<string, Waiter[]>();
  private readonly order: string[] = [];

  constructor(options: PagePoolOptions) {
    this.maxPages = Math.max(1, options.maxPages);
  }

  /** Wait for a page slot. The returned function releases it exactly once. */
  acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.maxPages && this.waiting === 0) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        this.remove(waiter);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = this.queues.get(sessionId) ?? [];
      queue.push(waiter);
      this.queues.set(sessionId, queue);
      if (!this.order.includes(sessionId)) this.order.push(sessionId);
    });
  }

  /** Open pages plus slots already handed to sessions. */
  get activePages(): number {
    return this.active;
  }

  /** Sessions currently waiting for a page slot. */
  get waiting(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handOff();
    };
  }

  private handOff(): void {
    while (this.order.length > 0) {
      const sessionId = this.order.shift()!;
      const queue = this.queues.get(sessionId);
      const waiter = queue?.shift();
      if (!queue || !waiter) {
        this.queues.delete(sessionId);
        continue;
      }
      if (queue.length > 0) {
        this.order.push(sessionId);
      } else {
        this.queues.delete(sessionId);
      }
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      // The slot transfers directly; `active` stays the same.
      waiter.resolve(this.releaser());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  private remove(waiter: Waiter): void {
    for (const [sessionId, queue] of this.queues) {
      const index = queue.indexOf(waiter);
      if (index < 0) continue;
      queue.splice(index, 1);
      if (queue.length === 0) {
        this.queues.delete(sessionId);
        const orderIndex = this.order.indexOf(sessionId);
        if (orderIndex >= 0) this.order.splice(orderIndex, 1);
      }
      return;
    }
  }
}

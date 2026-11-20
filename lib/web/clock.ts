/**
 * Time and cancellation for the shared web modules.
 *
 * Pacing, caching, and decay all need "now" and an abortable wait. Injecting a
 * clock keeps those rules testable without real delays.
 */

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolve after `ms`, rejecting with the signal's reason if it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep,
};

/** The reason a cancelled wait rejects with. */
export function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

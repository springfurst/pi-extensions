/** An error carrying an HTTP status when the failure came from a response. */
export class HttpError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Compose a caller signal with a hard timeout so an outbound request settles
 * even when the runtime fails to propagate cancellation to the transport.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface LimitedText {
  text: string;
  /** True when the body was cut at `maxBytes`. */
  truncated: boolean;
  bytes: number;
}

/**
 * Read a response body up to `maxBytes`, decoding as UTF-8. Over-cap bodies are
 * cut (not rejected) and reported through `truncated`.
 */
export async function readLimitedText(response: Response, maxBytes: number): Promise<LimitedText> {
  if (!response.body) return { text: "", truncated: false, bytes: 0 };
  const reader = response.body.getReader();
  let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const accepted = Math.min(value.byteLength, maxBytes - bytes);
      const nextBytes = bytes + accepted;
      if (nextBytes > buffer.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(nextBytes, buffer.byteLength * 2)),
        );
        grown.set(buffer.subarray(0, bytes));
        buffer = grown;
      }
      buffer.set(value.subarray(0, accepted), bytes);
      bytes = nextBytes;
      if (accepted < value.byteLength) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: new TextDecoder().decode(buffer.subarray(0, bytes)), truncated, bytes };
}

/** Lowercase a MIME type and strip its parameters. */
export function normalizeMime(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

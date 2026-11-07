import type { HTTPRequest, HTTPResponse } from "puppeteer-core";

const NETWORK_DETAIL_LIMIT = 50;

export interface NetworkDetail {
  request?: HTTPRequest;
  response?: HTTPResponse;
  body?: string;
  bodyTruncated?: boolean;
}

/** Bounded request/response handle cache for the network overview. */
export class NetworkDetailStore {
  private details = new Map<string, NetworkDetail>();

  touch(id: string, patch: { request?: HTTPRequest; response?: HTTPResponse }): void {
    const detail = this.details.get(id) ?? {};
    this.details.delete(id);
    this.details.set(id, { ...detail, ...patch });
    this.trim();
  }

  get(id: string): NetworkDetail | undefined {
    return this.details.get(id);
  }

  cacheBody(id: string, body: string, bodyTruncated: boolean): void {
    const detail = this.details.get(id) ?? {};
    this.details.delete(id);
    this.details.set(id, { ...detail, body, bodyTruncated });
    this.trim();
  }

  delete(id: string): void {
    this.details.delete(id);
  }

  clear(): void {
    this.details.clear();
  }

  private trim(): void {
    while (this.details.size > NETWORK_DETAIL_LIMIT) {
      const oldest = this.details.keys().next().value;
      if (oldest === undefined) break;
      this.details.delete(oldest);
    }
  }
}

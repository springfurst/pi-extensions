import type { HTTPRequest } from "puppeteer-core";
import { matchesRoute } from "./route";
import { sleep } from "./session-helpers";
import type { BrowserPilotSession } from "./session";
import type { ManagedTab, RouteRule } from "./types";

export class RouteController {
  readonly rules: RouteRule[] = [];
  private sequence = 0;

  constructor(private readonly session: BrowserPilotSession) {}

  get hasRules(): boolean {
    return this.rules.length > 0;
  }

  /** Add a request interception rule and enable interception on every tab. */
  async add(rule: Omit<RouteRule, "id">): Promise<RouteRule> {
    const created: RouteRule = { ...rule, id: `r${++this.sequence}` };
    this.rules.push(created);
    await this.setInterception(true);
    return created;
  }

  /** Remove one rule by id, disabling interception when no rules remain. */
  async remove(id: string): Promise<boolean> {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return false;
    this.rules.splice(index, 1);
    if (this.rules.length === 0) await this.setInterception(false);
    return true;
  }

  /** Remove all rules and disable interception. */
  async clear(): Promise<number> {
    const count = this.rules.length;
    this.rules.length = 0;
    await this.setInterception(false);
    return count;
  }

  private async setInterception(enabled: boolean): Promise<void> {
    for (const tab of this.session.tabs.values()) {
      if (tab.page.isClosed()) continue;
      await tab.page.setRequestInterception(enabled).catch(() => undefined);
    }
  }

  async apply(tab: ManagedTab, request: HTTPRequest): Promise<void> {
    if (request.isInterceptResolutionHandled()) return;
    let resourceType: string | undefined;
    try {
      resourceType = request.resourceType();
    } catch {
      resourceType = undefined;
    }
    const rule = this.rules.find((candidate) =>
      matchesRoute(candidate, request.url(), resourceType),
    );
    try {
      if (!rule) {
        await request.continue();
        return;
      }
      if (rule.action === "abort") {
        await request.abort("blockedbyclient");
      } else if (rule.action === "delay") {
        await sleep(rule.delayMs ?? 0);
        await request.continue();
      } else if (rule.action === "fulfill") {
        await request.respond({
          status: rule.status ?? 200,
          headers: rule.headers,
          contentType: rule.contentType ?? "text/plain",
          body: rule.body ?? "",
        });
      } else {
        await request.continue();
      }
    } catch {
      // A navigation or browser shutdown can close the request first.
    }
    tab.lastUsed = Date.now();
  }
}

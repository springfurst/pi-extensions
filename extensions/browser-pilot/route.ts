import type { RouteRule } from "./types";

/** Match a URL against a simple glob where `*` matches any run of characters. */
export function matchesUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i").test(url);
  } catch {
    return url.includes(pattern);
  }
}

/** True when a request matches a rule's URL and optional resource type. */
export function matchesRoute(
  rule: RouteRule,
  url: string,
  resourceType: string | undefined,
): boolean {
  if (!matchesUrlPattern(rule.urlPattern, url)) return false;
  if (!rule.resourceType) return true;
  return rule.resourceType.toLowerCase() === (resourceType ?? "").toLowerCase();
}

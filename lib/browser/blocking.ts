/**
 * Default subresource blocking for pages opened by the web tools.
 *
 * Only third-party ads, analytics, images, media, and fonts are blocked. A
 * first-party request is never touched, so a site's own layout and data still
 * load. The ad and analytics lists are deliberately short curated patterns
 * rather than a bundled blocklist: they catch the common trackers without
 * turning a page load into a filtering project.
 */

import type { BlockingCategory, BlockingConfig, HostPolicy } from "../web/config";

/** Resource types a browser reports for a request. */
export type ResourceKind =
  | "document"
  | "stylesheet"
  | "image"
  | "media"
  | "font"
  | "script"
  | "xhr"
  | "fetch"
  | "websocket"
  | "other";

/** Defaults used when a caller has no explicit blocking configuration. */
export const DEFAULT_BLOCKING: BlockingConfig = {
  ads: "third-party",
  analytics: "third-party",
  images: "third-party",
  media: "third-party",
  fonts: "third-party",
};

/** Hostname patterns for ad delivery networks. */
const AD_HOSTS: RegExp[] = [
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)adsrvr\.org$/i,
  /(^|\.)criteo\.(com|net)$/i,
  /(^|\.)taboola\.com$/i,
  /(^|\.)outbrain\.com$/i,
  /(^|\.)adform\.net$/i,
  /(^|\.)rubiconproject\.com$/i,
  /(^|\.)pubmatic\.com$/i,
];

/** Hostname patterns for analytics and telemetry. */
const ANALYTICS_HOSTS: RegExp[] = [
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)hotjar\.com$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)segment\.(io|com)$/i,
  /(^|\.)amplitude\.com$/i,
  /(^|\.)matomo\.(cloud|org)$/i,
  /(^|\.)plausible\.io$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)stats\.wp\.com$/i,
  /(^|\.)clarity\.ms$/i,
];

export interface BlockingRequest {
  /** Request URL. */
  url: string;
  /** Page that made the request, when known. */
  documentUrl?: string;
  /** Browser-reported resource type. */
  resourceType?: ResourceKind | string;
}

/**
 * Decide whether a request is blocked. `policy` allows a host to opt out of
 * individual categories with `hosts.<host>.allow`.
 */
export function shouldBlockRequest(
  request: BlockingRequest,
  config: BlockingConfig = DEFAULT_BLOCKING,
  policy?: Pick<HostPolicy, "allow">,
): BlockingCategory | undefined {
  const category = categoryOf(request, config);
  if (!category) return undefined;
  if (policy?.allow?.includes(category)) return undefined;
  return category;
}

/** True when any category is active, i.e. interception must be enabled. */
export function blockingEnabled(config: BlockingConfig = DEFAULT_BLOCKING): boolean {
  return Object.values(config).some((mode) => mode !== "off");
}

/** The category that blocks this request, or undefined. */
function categoryOf(
  request: BlockingRequest,
  config: BlockingConfig,
): BlockingCategory | undefined {
  const target = parse(request.url);
  if (!target) return undefined;
  const documentHost = request.documentUrl ? parse(request.documentUrl)?.host : undefined;
  const thirdParty = documentHost !== undefined && !sameSite(target.host, documentHost);
  if (documentHost !== undefined && !thirdParty) return undefined;

  switch (request.resourceType) {
    case "image":
      return config.images === "third-party" ? "images" : undefined;
    case "media":
      return config.media === "third-party" ? "media" : undefined;
    case "font":
      return config.fonts === "third-party" ? "fonts" : undefined;
    default:
      break;
  }

  const host = target.hostname;
  if (config.ads === "third-party" && AD_HOSTS.some((pattern) => pattern.test(host))) {
    return "ads";
  }
  if (config.analytics === "third-party" && ANALYTICS_HOSTS.some((pattern) => pattern.test(host))) {
    return "analytics";
  }
  return undefined;
}

/**
 * Same site without a public-suffix list: an exact host, a subdomain of the
 * document host, or a shared last two labels. This is an approximation, so an
 * unusual suffix such as `example.co.uk` is treated as one site defensively.
 */
export function sameSite(targetHost: string, documentHost: string): boolean {
  const left = targetHost.toLowerCase();
  const right = documentHost.toLowerCase();
  if (left === right) return true;
  if (left.endsWith(`.${right}`) || right.endsWith(`.${left}`)) return true;
  const leftSite = registrable(left);
  const rightSite = registrable(right);
  return leftSite !== undefined && leftSite === rightSite;
}

function registrable(host: string): string | undefined {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return undefined;
  return labels.slice(-2).join(".");
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

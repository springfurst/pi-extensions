/**
 * The user agent the web tools identify themselves with.
 *
 * Requests are honest about what they are: one descriptive product token and a
 * contact URL, configurable, with no per-request rotation. A site that wants to
 * block automated clients can find and contact the operator.
 */

/** Public contact URL used when no other contact is configured. */
export const DEFAULT_CONTACT = "https://github.com/springfurst/pi-extensions";

/** Product token used to match `robots.txt` groups. */
export const DEFAULT_PRODUCT_TOKEN = "pi-web-tools";

/** Default `User-Agent` value. */
export const DEFAULT_USER_AGENT = `${DEFAULT_PRODUCT_TOKEN}/1.0 (+${DEFAULT_CONTACT})`;

/**
 * The product token a user agent advertises: its first token, without version,
 * comment, or parameters, lowercased.
 */
export function productToken(userAgent: string = DEFAULT_USER_AGENT): string {
  const first = userAgent.trim().split(/\s+/)[0] ?? "";
  const token = first.replace(/[/;].*$/, "").replace(/^\(|\)$/g, "");
  return token.toLowerCase() || DEFAULT_PRODUCT_TOKEN;
}

export interface RequestHeadersOptions {
  userAgent?: string;
  /** Contact address sent in `From`; omitted when unset. */
  contact?: string;
}

/** Identity headers for one outbound request. */
export function identityHeaders(options: RequestHeadersOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
  };
  const contact = options.contact?.trim();
  if (contact) headers.From = contact;
  return headers;
}

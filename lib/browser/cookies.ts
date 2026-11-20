/**
 * Cookie access for requests that should carry a warm browser profile.
 *
 * Probes and content negotiation stay on the HTTP transport even when a browser
 * is available; handing them the profile's cookie header keeps the identity
 * consistent without a navigation.
 */

/** The subset of a Puppeteer browser needed to read cookies. */
export interface CookieJar {
  cookies(url?: string): Promise<Array<{ name: string; value: string }>>;
}

/** A `Cookie` header value for one URL, or undefined when the jar is empty. */
export async function cookieHeaderFor(
  browser: CookieJar,
  url: string,
): Promise<string | undefined> {
  let cookies: Array<{ name: string; value: string }>;
  try {
    cookies = await browser.cookies(url);
  } catch {
    return undefined;
  }
  const pairs = cookies
    .filter((cookie) => Boolean(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

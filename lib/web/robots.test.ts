import { describe, expect, it } from "vitest";
import { FakeClock } from "./__fixtures__/clock";
import {
  RobotsCache,
  parseRobots,
  robotsAllows,
  robotsDisallows,
  robotsIntervalMs,
  robotsTxtUrl,
} from "./robots";

const SAMPLE = `
# Example robots file
User-agent: *
Disallow: /private/
Allow: /private/public/
Disallow: /*.pdf$
Disallow: /tmp

User-agent: pi-web-tools
Disallow: /agent-only
Crawl-delay: 2.5
Request-rate: 1/5
Sitemap: https://example.com/sitemap.xml
`;

describe("parseRobots", () => {
  const rules = parseRobots(SAMPLE);

  it("selects the most specific group for the product token", () => {
    expect(rules.productToken).toBe("pi-web-tools");
    expect(rules.crawlDelayMs).toBe(2_500);
    expect(rules.requestRateIntervalMs).toBe(5_000);
    expect(robotsAllows(rules, "/agent-only").allowed).toBe(false);
    expect(robotsAllows(rules, "/private/secret").allowed).toBe(true);
  });

  it("collects sitemaps from the whole file", () => {
    expect(rules.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("prefers the longest matching rule", () => {
    const generic = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\n");
    expect(robotsAllows(generic, "/a").allowed).toBe(false);
    expect(robotsAllows(generic, "/a/b/c").allowed).toBe(true);
  });

  it("lets Allow win a tie", () => {
    const tie = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n");
    expect(robotsAllows(tie, "/page").allowed).toBe(true);
  });

  it("matches wildcards and a trailing anchor", () => {
    const wildcards = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*results\n");
    expect(robotsDisallows(wildcards, "/doc.pdf")).toBe(true);
    expect(robotsDisallows(wildcards, "/doc.pdf?download=1")).toBe(false);
    expect(robotsDisallows(wildcards, "/deep/dir/doc.pdf")).toBe(true);
    expect(robotsDisallows(wildcards, "/search/page/results")).toBe(true);
    expect(robotsDisallows(wildcards, "/search/page")).toBe(false);
  });

  it("treats an empty Disallow as permission", () => {
    const open = parseRobots("User-agent: *\nDisallow:\n");
    expect(robotsAllows(open, "/anything").matched).toBe(false);
    expect(robotsAllows(open, "/anything").allowed).toBe(true);
  });

  it("ignores comments, blank lines, and CRLF", () => {
    const messy = parseRobots(
      "User-agent: * # all robots\r\n\r\nDisallow: /x # commented\r\nNotAField: /y\r\n",
    );
    expect(robotsDisallows(messy, "/x")).toBe(true);
    expect(robotsDisallows(messy, "/y")).toBe(false);
  });

  it("ignores rules that appear before any user-agent group", () => {
    const orphan = parseRobots("Disallow: /\nUser-agent: *\nAllow: /\n");
    expect(orphan.groups.length).toBe(1);
    expect(robotsAllows(orphan, "/page").allowed).toBe(true);
  });

  it("groups consecutive user-agent lines together", () => {
    const grouped = parseRobots(
      "User-agent: alpha\nUser-agent: beta\nDisallow: /shared\nUser-agent: *\nDisallow: /\n",
    );
    expect(grouped.groups.length).toBe(2);
    expect(grouped.groups[0]?.agents).toEqual(["alpha", "beta"]);
  });

  it("starts a new group after directives", () => {
    const split = parseRobots(
      "User-agent: alpha\nDisallow: /one\nUser-agent: alpha\nDisallow: /two\n",
    );
    expect(split.groups.length).toBe(2);
    expect(split.groups[1]?.rules).toEqual([{ allow: false, pattern: "/two" }]);
  });

  it("matches a partial and case-insensitive product token", () => {
    const partial = parseRobots("User-agent: PI-WEB\nDisallow: /nope\n");
    expect(robotsDisallows(partial, "/nope")).toBe(true);

    const others = parseRobots("User-agent: otherbot\nDisallow: /nope\n");
    expect(robotsAllows(others, "/nope").allowed).toBe(true);
  });

  it("merges the crawl floors of every selected group", () => {
    const floors = parseRobots(
      "User-agent: pi-web-tools\nCrawl-delay: 1\nUser-agent: pi-web-tools\nRequest-rate: 1/10\n",
    );
    expect(robotsIntervalMs(floors)).toBe(10_000);
  });

  it("returns no interval when the file asks for none", () => {
    expect(robotsIntervalMs(parseRobots("User-agent: *\nDisallow: /x\n"))).toBeUndefined();
  });

  it("resolves an absolute URL to its path and query", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\n");
    expect(robotsDisallows(rules, "https://example.com/private?q=1")).toBe(true);
  });
});

describe("robotsTxtUrl", () => {
  it("builds the origin-relative URL", () => {
    expect(robotsTxtUrl("https://example.com")).toBe("https://example.com/robots.txt");
  });

  it("returns undefined for a relative origin", () => {
    expect(robotsTxtUrl("example.com")).toBeUndefined();
  });
});

describe("RobotsCache", () => {
  it("reads one origin once for the ttl", async () => {
    const clock = new FakeClock();
    const cache = new RobotsCache({ clock, ttlMs: 1_000 });
    let reads = 0;
    const load = async () => {
      reads++;
      return "User-agent: *\nDisallow: /x\n";
    };

    const first = await cache.rules("https://example.com", load);
    const second = await cache.rules("https://example.com", load);
    expect(reads).toBe(1);
    expect(second).toBe(first);

    clock.advanceBy(1_500);
    await cache.rules("https://example.com", load);
    expect(reads).toBe(2);
  });

  it("shares an in-flight read between callers", async () => {
    const cache = new RobotsCache();
    let reads = 0;
    let release!: (value: string) => void;
    const load = () => {
      reads++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = cache.rules("https://example.com", load);
    const second = cache.rules("https://example.com", load);
    expect(reads).toBe(1);
    release("User-agent: *\nDisallow: /\n");
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
  });

  it("treats a missing file as permission and caches it", async () => {
    const cache = new RobotsCache();
    let reads = 0;
    const load = async () => {
      reads++;
      return undefined;
    };
    const rules = await cache.rules("https://example.com", load);
    expect(rules.present).toBe(false);
    expect(robotsAllows(rules, "/anything").allowed).toBe(true);
    await cache.rules("https://example.com", load);
    expect(reads).toBe(1);
  });

  it("caches a failed read for the failure ttl only", async () => {
    const clock = new FakeClock();
    const cache = new RobotsCache({ clock, ttlMs: 60_000, failureTtlMs: 1_000 });
    let reads = 0;
    const load = async () => {
      reads++;
      throw new Error("network down");
    };
    const rules = await cache.rules("https://example.com", load);
    expect(rules.present).toBe(false);
    await cache.rules("https://example.com", load);
    expect(reads).toBe(1);
    clock.advanceBy(1_500);
    await cache.rules("https://example.com", load);
    expect(reads).toBe(2);
  });

  it("keeps origins and product tokens apart", async () => {
    const cache = new RobotsCache();
    const load = async () => "User-agent: alpha\nDisallow: /a\n";
    const alpha = await cache.rules("https://example.com", load, "alpha");
    const beta = await cache.rules("https://example.com", load, "beta");
    expect(robotsAllows(alpha, "/a").allowed).toBe(false);
    expect(robotsAllows(beta, "/a").allowed).toBe(true);
  });

  it("forgets everything on reset", async () => {
    const cache = new RobotsCache();
    let reads = 0;
    const load = async () => {
      reads++;
      return "User-agent: *\nDisallow: /\n";
    };
    await cache.rules("https://example.com", load);
    cache.reset();
    await cache.rules("https://example.com", load);
    expect(reads).toBe(2);
  });
});

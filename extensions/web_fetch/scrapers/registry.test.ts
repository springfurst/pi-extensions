import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HostPolicy } from "../../../lib/web/config";
import {
  SITE_REGISTRY,
  findSiteEntry,
  siteHostDefaults,
  siteMethods,
  type SiteStrategy,
} from "./registry";

const LADDER: readonly SiteStrategy[] = ["api", "reader", "browser"];

describe("SITE_REGISTRY data", () => {
  it("declares a unique id, label, and target set", () => {
    const ids = SITE_REGISTRY.map((entry) => entry.id);
    const labels = SITE_REGISTRY.map((entry) => entry.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const entry of SITE_REGISTRY) {
      expect(entry.targets.length).toBeGreaterThan(0);
      expect(typeof entry.handler).toBe("function");
    }
  });

  it("gives every parser method exactly one owner", () => {
    const owners = new Map<string, string>();
    for (const entry of SITE_REGISTRY) {
      expect(entry.methods.length).toBeGreaterThan(0);
      for (const method of entry.methods) {
        expect(owners.has(method), `${method} is declared twice`).toBe(false);
        owners.set(method, entry.id);
      }
    }
    expect(siteMethods().size).toBe(owners.size);
  });

  it("declares transports in ladder order", () => {
    for (const entry of SITE_REGISTRY) {
      expect(entry.strategies.length).toBeGreaterThan(0);
      const positions = entry.strategies.map((strategy) => LADDER.indexOf(strategy));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(new Set(entry.strategies).size).toBe(entry.strategies.length);
    }
  });

  it("keeps names it mentions in the public README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    for (const entry of SITE_REGISTRY) {
      expect(readme, `${entry.label} is missing from the README`).toContain(entry.label);
      for (const name of entry.env ?? []) {
        expect(readme, `${name} is missing from the README`).toContain(name);
      }
    }
  });
});

describe("findSiteEntry", () => {
  const cases: Array<[url: string, id: string | undefined]> = [
    ["https://github.com/nodejs/node", "github"],
    ["https://github.com/", "github"],
    ["https://api.github.com/repos/nodejs/node", undefined],
    ["https://gitlab.com/group/project", "gitlab"],
    ["https://npmjs.com/package/react", "npm"],
    ["https://www.npmjs.com/package/react", "npm"],
    ["https://pypi.org/project/requests/", "pypi"],
    ["https://www.pypi.org/project/requests/", "pypi"],
    ["https://crates.io/crates/serde", "crates-io"],
    ["https://www.crates.io/crates/serde", "crates-io"],
    ["https://developer.mozilla.org/en-US/docs/Web/API", "mdn"],
    ["https://docs.rs/serde/latest/serde/", "docs-rs"],
    ["https://wikipedia.org/wiki/Web_browser", "wikipedia"],
    ["https://en.wikipedia.org/wiki/Web_browser", "wikipedia"],
    ["https://de.wikipedia.org/wiki/Webbrowser", "wikipedia"],
    ["https://arxiv.org/abs/2401.00001", "arxiv"],
    ["https://www.semanticscholar.org/paper/abc", "semantic-scholar"],
    ["https://api.semanticscholar.org/graph/v1/paper/abc", "semantic-scholar"],
    ["https://pubmed.ncbi.nlm.nih.gov/12345/", "pubmed"],
    ["https://ncbi.nlm.nih.gov/pubmed/12345", "pubmed"],
    ["https://ncbi.nlm.nih.gov/pmc/articles/PMC1/", undefined],
    ["https://www.rfc-editor.org/rfc/rfc9110.html", "rfc"],
    ["https://datatracker.ietf.org/doc/html/rfc9110", "rfc"],
    ["https://tools.ietf.org/html/rfc9110", "rfc"],
    ["https://news.ycombinator.com/item?id=1", "hackernews"],
    ["https://stackoverflow.com/questions/1/how", "stackexchange"],
    ["https://unix.stackexchange.com/questions/1/how", "stackexchange"],
    ["https://superuser.com/questions/1/how", "stackexchange"],
    ["https://www.example.com/page", undefined],
    ["https://www.google.com/search?q=x", undefined],
    ["ftp://github.com/file", undefined],
    ["not a url", undefined],
  ];

  it.each(cases)("routes %s to %s", (url, id) => {
    expect(findSiteEntry(url)?.id).toBe(id);
  });

  it("matches hosts case-insensitively and ignores a path prefix on other hosts", () => {
    expect(findSiteEntry("https://GitHub.COM/nodejs/node")?.id).toBe("github");
    expect(findSiteEntry("https://github.com/pubmed/123")?.id).toBe("github");
  });
});

describe("siteHostDefaults", () => {
  const declared: Array<[host: string, minIntervalMs: number]> = [
    ["api.semanticscholar.org", 1_000],
    ["eutils.ncbi.nlm.nih.gov", 350],
    ["api.stackexchange.com", 500],
  ];

  it("declares starting gaps for fan-out hosts", () => {
    const defaults = siteHostDefaults();
    for (const [host, minIntervalMs] of declared) {
      expect(defaults[host]?.minIntervalMs).toBe(minIntervalMs);
    }
  });

  it("lets a configured host win", () => {
    const configured: Record<string, HostPolicy> = {
      "api.semanticscholar.org": { minIntervalMs: 4_000 },
      "api.stackexchange.com": { minIntervalMs: 2_000 },
    };
    const defaults = siteHostDefaults(configured);
    expect(defaults["api.semanticscholar.org"]).toBeUndefined();
    expect(defaults["api.stackexchange.com"]).toBeUndefined();
    expect(defaults["eutils.ncbi.nlm.nih.gov"]?.minIntervalMs).toBe(350);
  });

  it("lets a configured parent domain win over a more specific default", () => {
    const defaults = siteHostDefaults({ "semanticscholar.org": { minIntervalMs: 4_000 } });
    expect(defaults["api.semanticscholar.org"]).toBeUndefined();
    expect(defaults["eutils.ncbi.nlm.nih.gov"]?.minIntervalMs).toBe(350);
  });

  it("keeps the caller's own host map intact", () => {
    const configured: Record<string, HostPolicy> = { "example.com": { minIntervalMs: 10 } };
    const defaults = siteHostDefaults(configured);
    expect(defaults["example.com"]).toBeUndefined();
    expect(configured).toEqual({ "example.com": { minIntervalMs: 10 } });
  });
});

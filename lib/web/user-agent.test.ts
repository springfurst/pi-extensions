import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTACT,
  DEFAULT_PRODUCT_TOKEN,
  DEFAULT_USER_AGENT,
  identityHeaders,
  productToken,
} from "./user-agent";

describe("user agent identity", () => {
  it("is honest about the client and carries a contact", () => {
    expect(DEFAULT_USER_AGENT).toContain(DEFAULT_PRODUCT_TOKEN);
    expect(DEFAULT_USER_AGENT).toContain(DEFAULT_CONTACT);
    expect(DEFAULT_USER_AGENT.startsWith("Mozilla/")).toBe(false);
  });

  it("derives the product token used for robots matching", () => {
    expect(productToken()).toBe(DEFAULT_PRODUCT_TOKEN);
    expect(productToken("pi-web-tools/1.0 (+https://example.org)")).toBe("pi-web-tools");
    expect(productToken("ExampleBot")).toBe("examplebot");
    expect(productToken("  ")).toBe(DEFAULT_PRODUCT_TOKEN);
  });

  it("sends one user agent and an optional From header", () => {
    expect(identityHeaders()).toEqual({ "User-Agent": DEFAULT_USER_AGENT });
    expect(identityHeaders({ userAgent: "custom-agent/2.0" })).toEqual({
      "User-Agent": "custom-agent/2.0",
    });
    expect(identityHeaders({ contact: "ops@example.org" })).toEqual({
      "User-Agent": DEFAULT_USER_AGENT,
      From: "ops@example.org",
    });
    expect(identityHeaders({ contact: "   " })).toEqual({ "User-Agent": DEFAULT_USER_AGENT });
  });
});

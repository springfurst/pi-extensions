import { describe, expect, it } from "vitest";
import { classifyChallenge } from "./challenge";

const base = { url: "https://example.com", title: "", text: "", markers: [] };

describe("classifyChallenge", () => {
  it("recognizes a Cloudflare interstitial as blocking", () => {
    const challenge = classifyChallenge({
      ...base,
      title: "Just a moment...",
      text: "Checking your browser before accessing the site.",
      markers: ["#challenge-form", 'script[src*="challenge-platform"]'],
    });
    expect(challenge).toMatchObject({
      type: "cloudflare",
      severity: "blocking",
    });
    expect(challenge?.evidence.length).toBeGreaterThan(0);
  });

  it("recognizes a challenge marker without challenge text", () => {
    const challenge = classifyChallenge({
      ...base,
      markers: ["#cf-challenge-running"],
    });
    expect(challenge?.severity).toBe("blocking");
  });

  it("reports a captcha widget on a normal form as present, not blocking", () => {
    const challenge = classifyChallenge({
      ...base,
      title: "Contact us",
      text: "Fill in the form and submit.",
      markers: ['iframe[src*="recaptcha"]'],
    });
    expect(challenge).toMatchObject({
      type: "recaptcha",
      severity: "present",
    });
  });

  it("returns undefined for an ordinary page", () => {
    expect(
      classifyChallenge({
        ...base,
        title: "Documentation",
        text: "Welcome to the docs.",
      }),
    ).toBeUndefined();
  });

  it("recognizes a generic access-denied page", () => {
    const challenge = classifyChallenge({
      ...base,
      title: "Access Denied",
      text: "You do not have permission to access this server.",
    });
    expect(challenge?.severity).toBe("blocking");
    expect(challenge?.type).toBe("generic");
  });
});

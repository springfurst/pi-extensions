import { describe, expect, it } from "vitest";
import {
  checkUrlAllowed,
  isBlockedHostname,
  isPrivateAddress,
  normalizeIpv4Address,
} from "./security";

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local, metadata, and reserved ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "2852039166",
      "0xa9fea9fe",
      "0251.0376.0251.0376",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("normalizes alternate IPv4 spellings", () => {
    expect(normalizeIpv4Address("2852039166")).toBe("169.254.169.254");
    expect(normalizeIpv4Address("0xa9fea9fe")).toBe("169.254.169.254");
    expect(normalizeIpv4Address("0251.0376.0251.0376")).toBe("169.254.169.254");
    expect(normalizeIpv4Address("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(normalizeIpv4Address("::ffff:169.254.169.254")).toBe("169.254.169.254");
    expect(normalizeIpv4Address("8.8.8.8")).toBe("8.8.8.8");
    expect(normalizeIpv4Address("2606:4700::1111")).toBeUndefined();
  });

  it("allows public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("isBlockedHostname", () => {
  it("flags localhost aliases and metadata services", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("LOCALHOST")).toBe(true);
    expect(isBlockedHostname("app.localhost")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal.")).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});

describe("checkUrlAllowed", () => {
  it("rejects non-http(s) schemes", async () => {
    expect((await checkUrlAllowed("ftp://example.com", { allowPrivateHosts: false })).allowed).toBe(
      false,
    );
  });

  it("blocks private hosts unless opted out", async () => {
    const resolve = async () => ["127.0.0.1"];
    expect(
      (await checkUrlAllowed("http://internal.test/", { allowPrivateHosts: false, resolve }))
        .allowed,
    ).toBe(false);
    expect(
      (await checkUrlAllowed("http://internal.test/", { allowPrivateHosts: true, resolve }))
        .allowed,
    ).toBe(true);
  });

  it("blocks when any resolved address is private", async () => {
    const resolve = async () => ["93.184.216.34", "10.0.0.1"];
    expect(
      (await checkUrlAllowed("http://mixed.test/", { allowPrivateHosts: false, resolve })).allowed,
    ).toBe(false);
  });

  it("allows public hosts and blocks resolution failures", async () => {
    const publicResolve = async () => ["93.184.216.34"];
    expect(
      (
        await checkUrlAllowed("https://example.com/", {
          allowPrivateHosts: false,
          resolve: publicResolve,
        })
      ).allowed,
    ).toBe(true);
    const failingResolve = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(
      (
        await checkUrlAllowed("https://nope.test/", {
          allowPrivateHosts: false,
          resolve: failingResolve,
        })
      ).allowed,
    ).toBe(false);
  });
});

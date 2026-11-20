/**
 * The identity a browser presents, derived from the binary that actually runs.
 *
 * The user agent is only overridden when a caller asks for one; client hints
 * are built from the same version and platform, so a pinned user agent never
 * disagrees with `Sec-CH-UA`.
 */

export interface ClientHintBrand {
  brand: string;
  version: string;
}

export interface ClientHintMetadata {
  brands: ClientHintBrand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

export interface Fingerprint {
  major: string;
  userAgent: string;
  metadata: ClientHintMetadata;
}

/** Extract the Chrome version from `Chrome/131.0.6778.85` or a version string. */
export function chromeVersionOf(raw: string): { major: string; full: string } | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (match) return { major: match[1]!, full: match.slice(1).join(".") };
  const major = /^(\d+)$/.exec(raw.trim());
  return major ? { major: major[1]!, full: `${major[1]}.0.0.0` } : undefined;
}

/** Build a Chrome fingerprint for the platform the browser is running on. */
export function fingerprintFor(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Fingerprint {
  const chrome = chromeVersionOf(version) ?? { major: "131", full: "131.0.0.0" };
  const { major, full } = chrome;
  const system = systemFor(platform, arch);
  const userAgent =
    `Mozilla/5.0 (${system.userAgent}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${full} Safari/537.36`;
  return {
    major,
    userAgent,
    metadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand: "Not A(Brand", version: "24" },
        { brand: "Google Chrome", version: major },
      ],
      fullVersion: full,
      platform: system.platform,
      platformVersion: system.platformVersion,
      architecture: system.architecture,
      model: "",
      mobile: false,
    },
  };
}

/**
 * Navigation headers for a document request, built from the fingerprint so the
 * user agent and every `Sec-CH-UA*` hint carry the same version and platform.
 */
export function navigationHeaders(fingerprint: Fingerprint): Record<string, string> {
  const { metadata } = fingerprint;
  return {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    Priority: "u=0, i",
    "Sec-Ch-Ua": metadata.brands.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(", "),
    "Sec-Ch-Ua-Mobile": metadata.mobile ? "?1" : "?0",
    "Sec-Ch-Ua-Platform": `"${metadata.platform}"`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": fingerprint.userAgent,
  };
}

interface SystemTokens {
  userAgent: string;
  platform: string;
  platformVersion: string;
  architecture: string;
}

function systemFor(platform: NodeJS.Platform, arch: string): SystemTokens {
  const architecture = arch === "arm64" ? "arm" : arch === "ia32" ? "x86" : "x86";
  if (platform === "win32") {
    return {
      userAgent: "Windows NT 10.0; Win64; x64",
      platform: "Windows",
      platformVersion: "15.0.0",
      architecture,
    };
  }
  if (platform === "darwin") {
    return {
      userAgent: "Macintosh; Intel Mac OS X 10_15_7",
      platform: "macOS",
      platformVersion: "14.0.0",
      architecture,
    };
  }
  return {
    userAgent: "X11; Linux x86_64",
    platform: "Linux",
    platformVersion: "6.0.0",
    architecture,
  };
}

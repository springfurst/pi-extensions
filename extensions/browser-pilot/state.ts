import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CookieData } from "puppeteer-core";
import { finalize, hint, pageHeader } from "./output";
import { checkNavigationAllowed } from "./security";
import type { BrowserPilotSession } from "./session";
import { resolvePath } from "./tool-helpers";
import type { BrowserPilotContext, BrowserPilotParams, BrowserPilotToolResult } from "./types";
import { BrowserPilotError } from "./types";

export interface StorageStateBundle {
  version: 1;
  exportedAt: string;
  cookies: CookieData[];
  origins: Array<{
    origin: string;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  }>;
}

export async function stateResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  await session.ensure(ctx.signal);
  const tab = await session.ensureTab(params.tab);
  const path = resolvePath(ctx.cwd, params.path!);
  if (params.operation === "export") {
    const cookies = (await session.browser!.cookies()) as CookieData[];
    const origins = new Map<string, StorageStateBundle["origins"][number]>();
    for (const candidate of session.tabs.values()) {
      if (candidate.page.isClosed()) continue;
      const url = candidate.page.url();
      if (!/^https?:/i.test(url)) continue;
      const snapshot = await candidate.page
        .evaluate(() => ({
          origin: location.origin,
          localStorage: Object.fromEntries(Object.entries(localStorage)),
          sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
        }))
        .catch(() => undefined);
      if (!snapshot) continue;
      const existing = origins.get(snapshot.origin);
      origins.set(snapshot.origin, {
        origin: snapshot.origin,
        localStorage: { ...(existing?.localStorage ?? {}), ...snapshot.localStorage },
        sessionStorage: { ...(existing?.sessionStorage ?? {}), ...snapshot.sessionStorage },
      });
    }
    const bundle: StorageStateBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      cookies,
      origins: [...origins.values()],
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        `Exported ${cookies.length} cookie(s) and ${bundle.origins.length} origin(s) to ${path}.`,
        hint("the bundle contains session credentials; keep it private and delete it when done."),
      ].join("\n"),
      {
        action: "state",
        op: "export",
        tab: tab.handle,
        url: tab.page.url(),
        savedPath: path,
        cookies: cookies.length,
        origins: bundle.origins.length,
      },
    );
  }

  const bundle = readStorageState(path);
  let importedCookies = 0;
  let cookieFailures = 0;
  for (const cookie of bundle.cookies) {
    try {
      await session.browser!.setCookie(cookie);
      importedCookies++;
    } catch {
      cookieFailures++;
    }
  }
  let importedOrigins = 0;
  let originFailures = 0;
  for (const origin of bundle.origins) {
    const guard = await checkNavigationAllowed(origin.origin, session.navigationGuardOptions());
    if (!guard.allowed) {
      originFailures++;
      continue;
    }
    try {
      await importOriginStorage(session, tab, origin);
      importedOrigins++;
    } catch {
      // A single origin can fail without invalidating the rest of the bundle.
      originFailures++;
    }
  }
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Imported ${importedCookies} cookie(s) and ${importedOrigins} origin(s) from ${path}.`,
      cookieFailures > 0 ? `${cookieFailures} cookie(s) could not be set.` : undefined,
      originFailures > 0
        ? `${originFailures} origin(s) were blocked or could not be imported.`
        : undefined,
      hint("reload the page so the imported state takes effect."),
    ]
      .filter((line): line is string => !!line)
      .join("\n"),
    {
      action: "state",
      op: "import",
      tab: tab.handle,
      url: tab.page.url(),
      savedPath: path,
      cookies: importedCookies,
      origins: importedOrigins,
      cookieFailures,
      originFailures,
    },
  );
}

function readStorageState(path: string): StorageStateBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new BrowserPilotError(
      `Could not read storage state ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'Export a bundle first with {action:"state", params:{operation:"export", path:"./auth.json"}}.',
    );
  }
  return validateStorageBundle(parsed);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/** Validate a versioned auth-state bundle before any navigation or storage write. */
export function validateStorageBundle(value: unknown): StorageStateBundle {
  if (!value || typeof value !== "object") {
    throw new BrowserPilotError("Storage state is not a JSON object.");
  }
  const bundle = value as Partial<StorageStateBundle>;
  if (bundle.version !== 1 || !Array.isArray(bundle.cookies) || !Array.isArray(bundle.origins)) {
    throw new BrowserPilotError(
      "Storage state has an unsupported format.",
      "Use a bundle exported by this tool (version 1).",
    );
  }
  for (const cookie of bundle.cookies) {
    if (
      !cookie ||
      typeof cookie !== "object" ||
      typeof (cookie as CookieData).name !== "string" ||
      typeof (cookie as CookieData).value !== "string"
    ) {
      throw new BrowserPilotError("Storage state contains an invalid cookie entry.");
    }
  }
  const origins = bundle.origins.map((origin) => {
    if (!origin || typeof origin !== "object" || typeof origin.origin !== "string") {
      throw new BrowserPilotError("Storage state contains an invalid origin entry.");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin.origin);
    } catch {
      throw new BrowserPilotError(`Storage state contains an invalid origin: ${origin.origin}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserPilotError(
        `Storage state origin must be http(s): ${origin.origin}`,
        "Re-export the bundle from a browser-pilot session.",
      );
    }
    if (!isStringRecord(origin.localStorage) || !isStringRecord(origin.sessionStorage)) {
      throw new BrowserPilotError(
        `Storage state origin ${origin.origin} has invalid storage values.`,
      );
    }
    return {
      origin: origin.origin,
      localStorage: { ...origin.localStorage },
      sessionStorage: { ...origin.sessionStorage },
    };
  });
  return {
    version: 1,
    exportedAt: typeof bundle.exportedAt === "string" ? bundle.exportedAt : "",
    cookies: bundle.cookies as CookieData[],
    origins,
  };
}

async function importOriginStorage(
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  origin: StorageStateBundle["origins"][number],
): Promise<void> {
  const client = await tab.page.createCDPSession();
  try {
    for (const [key, value] of Object.entries(origin.localStorage ?? {})) {
      await client.send("DOMStorage.setDOMStorageItem", {
        storageId: { securityOrigin: origin.origin, isLocalStorage: true },
        key,
        value: String(value),
      });
    }
    for (const [key, value] of Object.entries(origin.sessionStorage ?? {})) {
      await client.send("DOMStorage.setDOMStorageItem", {
        storageId: { securityOrigin: origin.origin, isLocalStorage: false },
        key,
        value: String(value),
      });
    }
  } catch {
    await importOriginStorageViaPage(session, origin);
  } finally {
    await client.detach().catch(() => undefined);
  }
}

async function importOriginStorageViaPage(
  session: BrowserPilotSession,
  origin: StorageStateBundle["origins"][number],
): Promise<void> {
  const guard = await checkNavigationAllowed(origin.origin, session.navigationGuardOptions());
  if (!guard.allowed) {
    throw new BrowserPilotError(`Blocked storage origin: ${guard.reason ?? origin.origin}`);
  }
  const page = await session.browser!.newPage();
  try {
    await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.evaluate(
      (data) => {
        for (const [key, value] of Object.entries(data.local)) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(data.session)) sessionStorage.setItem(key, value);
      },
      { local: origin.localStorage ?? {}, session: origin.sessionStorage ?? {} },
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

import { finalize, pageHeader } from "../output";
import type { BrowserPilotSession } from "../session";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotParams,
  BrowserPilotToolResult,
} from "../types";
import { BrowserPilotError } from "../types";

export async function dialogResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const result = await session.resolveDialog({
    op: params.op as "accept" | "dismiss" | "policy",
    text: params.text,
    policy: params.policy,
  });
  const text = result.dialog
    ? `${params.op === "accept" ? "Accepted" : "Dismissed"} ${result.dialog.type}: ${result.dialog.message}`
    : `Dialog policy: ${result.policy}`;
  return finalize(text, {
    action: "dialog",
    op: params.op,
    policy: result.policy,
    dialog: result.dialog,
  });
}

export async function downloadResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.op === "clear") {
    const count = session.clearDownloads();
    return finalize(`Cleared ${count} download record(s).`, {
      action: "download",
      op: "clear",
      tab: tab.handle,
      count,
    });
  }
  if (params.op === "wait") {
    const timeout = params.timeout_ms ?? session.config.actionTimeoutSeconds * 1000;
    const download = await session.waitForDownload(timeout, params.filter, ctx.signal);
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        `Download ${download.state}: ${download.path}`,
        `${download.suggestedFilename} · ${download.receivedBytes}/${download.totalBytes} bytes`,
      ].join("\n"),
      {
        action: "download",
        op: "wait",
        tab: tab.handle,
        url: tab.page.url(),
        download,
        savedPath: download.path,
      },
    );
  }
  const limit = params.limit ?? 100;
  const downloads = session.listDownloads(params.filter).slice(-limit);
  const body =
    downloads.length > 0
      ? downloads
          .map(
            (download) =>
              `[${download.state}] ${download.suggestedFilename} · ${download.receivedBytes}/${download.totalBytes} bytes · ${download.path}`,
          )
          .join("\n")
      : "No downloads recorded.";
  return finalize(
    [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), "", body].join(
      "\n",
    ),
    {
      action: "download",
      op: "list",
      tab: tab.handle,
      url: tab.page.url(),
      count: downloads.length,
      downloads,
    },
  );
}

export async function cookiesResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const browser = session.browser!;
  const op = String(params.op);
  if (op === "list") {
    const cookies = params.url ? await tab.page.cookies(params.url) : await browser.cookies();
    const body =
      cookies.length > 0
        ? cookies
            .map(
              (cookie) =>
                `${cookie.name}=${cookie.value} · domain=${cookie.domain} path=${cookie.path}` +
                ` · expires=${cookie.expires} secure=${cookie.secure} httpOnly=${cookie.httpOnly}` +
                (cookie.sameSite ? ` sameSite=${cookie.sameSite}` : ""),
            )
            .join("\n")
        : "No cookies.";
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        "",
        body,
      ].join("\n"),
      {
        action: "cookies",
        op,
        tab: tab.handle,
        url: tab.page.url(),
        count: cookies.length,
        cookies,
      },
    );
  }
  if (op === "set") {
    const cookie = {
      name: params.name!,
      value: params.value!,
      domain: params.domain,
      path: params.cookie_path ?? "/",
      expires: params.expires,
      httpOnly: params.http_only,
      secure: params.secure,
      sameSite: params.same_site,
      url: params.url,
    };
    if (params.url) await tab.page.setCookie(cookie);
    else await browser.setCookie({ ...cookie, domain: params.domain! });
    return finalize(`Set cookie ${params.name}.`, {
      action: "cookies",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      name: params.name,
    });
  }
  if (op === "delete") {
    const request = {
      name: params.name!,
      url: params.url,
      domain: params.domain,
      path: params.cookie_path,
    };
    await browser.deleteMatchingCookies(request);
    return finalize(`Deleted cookie ${params.name}.`, {
      action: "cookies",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      name: params.name,
    });
  }
  const cookies = await browser.cookies();
  for (const cookie of cookies) {
    await browser.deleteCookie(cookie);
  }
  return finalize(`Cleared ${cookies.length} cookie(s).`, {
    action: "cookies",
    op: "clear",
    tab: tab.handle,
    url: tab.page.url(),
    count: cookies.length,
  });
}

export async function storageResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const area = params.area === "session" ? "sessionStorage" : "localStorage";
  const result = await tab.page.evaluate(
    ({ areaName, op, key, value }) => {
      const storage = window[areaName as "localStorage" | "sessionStorage"];
      if (op === "keys") return Object.keys(storage);
      if (op === "get") return key === undefined ? null : storage.getItem(key);
      if (op === "set") {
        storage.setItem(key ?? "", value ?? "");
        return true;
      }
      if (op === "remove") {
        storage.removeItem(key ?? "");
        return true;
      }
      storage.clear();
      return true;
    },
    { areaName: area, op: params.op, key: params.key, value: params.value },
  );
  const text =
    params.op === "get"
      ? result === null
        ? `${params.key} is not set in ${area}.`
        : String(result)
      : params.op === "keys"
        ? Array.isArray(result) && result.length > 0
          ? result.join("\n")
          : `No keys in ${area}.`
        : `${params.op} ${area}${params.key ? ` key ${params.key}` : ""}.`;
  return finalize(
    [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), text].join(
      "\n",
    ),
    {
      action: "storage",
      op: params.op,
      tab: tab.handle,
      url: tab.page.url(),
      area,
      key: params.key,
      value: result,
    },
  );
}

export async function emulateResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const previousPermissions = session.emulation.permissions;
  const state = params.reset ? {} : { ...session.emulation };
  if (params.reset) {
    state.network = null;
    state.geolocation = null;
    state.cpuThrottle = 1;
    state.colorScheme = "no-preference";
    state.reducedMotion = "no-preference";
    state.permissions = null;
    if (previousPermissions) {
      await session
        .setPermissions([], previousPermissions.origin, params.tab)
        .catch(() => undefined);
    }
  }
  if (params.width !== undefined || params.height !== undefined) {
    const current = state.viewport ?? {
      width: session.config.viewport.width,
      height: session.config.viewport.height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
    state.viewport = {
      ...current,
      width: params.width ?? current.width,
      height: params.height ?? current.height,
      deviceScaleFactor: params.device_scale_factor ?? current.deviceScaleFactor,
      isMobile: params.is_mobile ?? current.isMobile,
      hasTouch: params.has_touch ?? current.hasTouch,
    };
  } else if (
    params.device_scale_factor !== undefined ||
    params.is_mobile !== undefined ||
    params.has_touch !== undefined
  ) {
    const current = state.viewport ?? {
      width: session.config.viewport.width,
      height: session.config.viewport.height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
    state.viewport = {
      ...current,
      deviceScaleFactor: params.device_scale_factor ?? current.deviceScaleFactor,
      isMobile: params.is_mobile ?? current.isMobile,
      hasTouch: params.has_touch ?? current.hasTouch,
    };
  }
  if (params.user_agent !== undefined) state.userAgent = params.user_agent;
  if (params.locale !== undefined) state.locale = params.locale;
  if (params.timezone !== undefined) state.timezone = params.timezone;
  if (params.color_scheme !== undefined) state.colorScheme = params.color_scheme;
  if (params.reduced_motion !== undefined) state.reducedMotion = params.reduced_motion;
  if (params.cpu_throttle !== undefined) state.cpuThrottle = params.cpu_throttle;
  if (params.network_profile) {
    const profile = session.networkProfile(params.network_profile);
    state.network = {
      offline: params.network_profile === "offline",
      latency: params.latency ?? profile.latency,
      download: params.download_throughput ?? profile.download,
      upload: params.upload_throughput ?? profile.upload,
    };
  } else if (
    params.latency !== undefined ||
    params.download_throughput !== undefined ||
    params.upload_throughput !== undefined
  ) {
    const current = state.network ?? { offline: false, latency: 0, download: 0, upload: 0 };
    state.network = {
      offline: current.offline ?? false,
      latency: params.latency ?? current.latency,
      download: params.download_throughput ?? current.download,
      upload: params.upload_throughput ?? current.upload,
    };
  }
  if (params.latitude !== undefined || params.longitude !== undefined) {
    state.geolocation = {
      latitude: params.latitude ?? 0,
      longitude: params.longitude ?? 0,
      accuracy: params.accuracy,
    };
  }
  if (params.permissions !== undefined) {
    const granted = await session.setPermissions(params.permissions, params.origin, params.tab);
    state.permissions = { origin: granted.origin, values: granted.permissions };
  }
  const info = await session.setEmulation(params.tab, state);
  return finalize(
    [pageHeader(info.handle, info.url, info.title), `Emulation: ${describeEmulation(state)}`].join(
      "\n",
    ),
    {
      action: "emulate",
      tab: info.handle,
      url: info.url,
      title: info.title,
      emulation: state,
    },
  );
}

export function describeEmulation(state: BrowserPilotSession["emulation"]): string {
  const parts: string[] = [];
  if (state.viewport) {
    parts.push(
      `viewport ${state.viewport.width}×${state.viewport.height}` +
        (state.viewport.isMobile ? " mobile" : "") +
        (state.viewport.hasTouch ? " touch" : ""),
    );
  }
  if (state.userAgent) parts.push("user-agent");
  if (state.locale) parts.push(`locale ${state.locale}`);
  if (state.timezone) parts.push(`timezone ${state.timezone}`);
  if (state.colorScheme) parts.push(`color-scheme ${state.colorScheme}`);
  if (state.reducedMotion) parts.push(`reduced-motion ${state.reducedMotion}`);
  if (state.network) {
    parts.push(
      state.network.offline
        ? "offline"
        : `network ${state.network.download}/${state.network.upload} B/s, ${state.network.latency}ms`,
    );
  }
  if (state.cpuThrottle && state.cpuThrottle !== 1) parts.push(`cpu ×${state.cpuThrottle}`);
  if (state.geolocation) parts.push("geolocation");
  if (state.permissions) {
    parts.push(
      `permissions ${state.permissions.values.join(",") || "none"} @ ${state.permissions.origin}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "defaults";
}

export async function routeResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  _config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  if (params.op === "list") {
    const body =
      session.routeRules.length > 0
        ? session.routeRules
            .map(
              (rule) =>
                `${rule.id} ${rule.action} ${rule.urlPattern}` +
                (rule.resourceType ? ` (${rule.resourceType})` : "") +
                (rule.status ? ` status=${rule.status}` : "") +
                (rule.delayMs ? ` delay=${rule.delayMs}ms` : ""),
            )
            .join("\n")
        : "No route rules.";
    return finalize(body, {
      action: "route",
      op: "list",
      count: session.routeRules.length,
      rules: session.routeRules,
    });
  }
  if (params.op === "clear") {
    const count = await session.clearRouteRules();
    return finalize(`Cleared ${count} route rule(s).`, {
      action: "route",
      op: "clear",
      count,
    });
  }
  if (params.op === "remove") {
    const removed = await session.removeRouteRule(params.id!);
    if (!removed) {
      throw new BrowserPilotError(
        `No route rule with id ${params.id}.`,
        'Run {action:"route", op:"list"} to see rule ids.',
      );
    }
    return finalize(`Removed route rule ${params.id}.`, {
      action: "route",
      op: "remove",
      id: params.id,
    });
  }
  await session.ensure();
  const rule = await session.addRouteRule({
    urlPattern: params.url_pattern ?? "*",
    resourceType: params.resource_type,
    action: params.route_action!,
    status: params.status,
    body: params.body,
    contentType: params.content_type,
    headers: params.headers,
    delayMs: params.delay_ms,
  });
  return finalize(`Added route rule ${rule.id}: ${rule.action} ${rule.urlPattern}`, {
    action: "route",
    op: "add",
    rule,
  });
}

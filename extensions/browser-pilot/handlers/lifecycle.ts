import { detectChallenge } from "../challenge";
import {
  instanceRecordPath,
  pidAlive,
  probeInstance,
  readInstanceRecord,
  shouldRunHeadless,
} from "../launcher";
import { finalize, formatChallenge, formatTabs, hint, pageHeader } from "../output";
import { navigateText } from "./navigation";
import { previewProfile, type BrowserPilotSession } from "../session";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotDetails,
  BrowserPilotParams,
  ChallengeInfo,
  BrowserPilotToolResult,
} from "../types";
import { BrowserPilotError } from "../types";

export async function statusResult(
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<{ text: string; details: BrowserPilotDetails }> {
  const profile =
    session.profile ?? previewProfile(config, session.sessionId, session.agentDir, session.cwd);
  const mode = shouldRunHeadless(config) ? "headless" : "headful";
  if (!session.instance) {
    const lines = [
      "Browser: not running",
      `Profile: ${profile.label} (${profile.userDataDir}) ${profile.persistent ? "[persistent]" : "[isolated]"}`,
      `Mode: ${mode}`,
      "Tabs: 0",
    ];
    const record = readInstanceRecord(instanceRecordPath(session.agentDir, profile.key));
    if (record && pidAlive(record.pid)) {
      const probe = await probeInstance(record.port).catch(() => undefined);
      if (probe) {
        const owner = record.ownerSessionId ? `, session ${record.ownerSessionId}` : "";
        lines.push(`Profile owner: pid ${record.pid}, port ${record.port}${owner}`);
        lines.push(
          hint('this profile is already in use; use profile:"session" or a named profile.'),
        );
      }
    }
    lines.push("", hint('call {action:"open"} to start Chrome.'));
    const text = lines.join("\n");
    return {
      text,
      details: {
        action: "status",
        profile: profile.label,
        userDataDir: profile.userDataDir,
        headless: shouldRunHeadless(config),
      },
    };
  }

  const tabs = session.browser?.connected ? await session.listTabs() : [];
  const current = tabs.find((tab) => tab.current);
  let challenge: ChallengeInfo | undefined;
  if (session.browser?.connected && session.current !== undefined && !session.pendingDialog) {
    const tab = session.tabs.get(session.current);
    if (tab && !tab.page.isClosed()) {
      challenge = await detectChallenge(tab.page).catch(() => undefined);
      session.challenge = challenge;
    }
  }
  const lines = [
    `Browser: ${session.browser?.connected ? "running" : "disconnected"}`,
    `Chrome: ${session.instance.chromeVersion ?? "unknown"}`,
    `Profile: ${profile.label} (${profile.userDataDir}) ${profile.persistent ? "[persistent]" : "[isolated]"}`,
    `Process: pid ${session.instance.pid}, port ${session.instance.port}`,
    `Mode: ${mode}`,
    `External: ${session.instance.external ? "yes" : "no"}`,
    formatTabs(tabs, config.maxTabs),
  ];
  if (challenge) lines.push(`Challenge: ${formatChallenge(challenge)}`);
  if (session.pendingDialog) {
    lines.push(`Dialog: ${session.pendingDialog.type} "${session.pendingDialog.message}"`);
  }
  if (!session.browser?.connected) {
    lines.push("", hint("the next action will try to reconnect."));
  } else if (challenge?.severity === "blocking") {
    lines.push(
      "",
      hint('solve the challenge in the Chrome window, then run {action:"wait", for:"human"}.'),
    );
  }
  return {
    text: lines.join("\n"),
    details: {
      action: "status",
      profile: profile.label,
      userDataDir: profile.userDataDir,
      pid: session.instance.pid,
      port: session.instance.port,
      chromeVersion: session.instance.chromeVersion,
      headless: shouldRunHeadless(config),
      external: session.instance.external ?? false,
      tabs,
      challenge,
      tab: current?.handle,
      url: current?.url,
      title: current?.title,
      pendingDialog: session.pendingDialog,
    },
  };
}

export async function openResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  if (params.profile && params.profile !== session.config.profile) {
    if (session.instance || session.browser) {
      throw new BrowserPilotError(
        `This session is already using profile "${session.config.profile}".`,
        "Close the browser first, then open with the new profile.",
      );
    }
    session.config = { ...session.config, profile: params.profile };
  }
  await session.ensure(ctx.signal);
  if (params.url) {
    const nav = await session.navigate(
      params.url,
      undefined,
      params.wait_until,
      params.timeout_ms,
      ctx.signal,
      params.tab,
    );
    return navigateText(nav);
  }
  const tab = await session.ensureTab(params.tab);
  tab.lastUsed = Date.now();
  await tab.page.bringToFront().catch(() => undefined);
  session.persist();
  const infos = await session.listTabs();
  const info = infos.find((candidate) => candidate.handle === tab.handle)!;
  const text = [
    pageHeader(info.handle, info.url, info.title),
    "",
    formatTabs(infos, config.maxTabs),
    "",
    hint('run {action:"snapshot"} to see interactive elements, or {action:"navigate", url:"..."}.'),
  ].join("\n");
  return finalize(text, {
    action: "open",
    tab: info.handle,
    url: info.url,
    title: info.title,
    tabs: infos,
  });
}

export async function closeResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const target = params.target;
  if (target === "browser") {
    if (!session.instance) {
      return finalize("No browser was running.", { action: "close", target });
    }
    const profile = session.profile?.label;
    await session.dispose();
    return finalize(`Closed the browser${profile ? ` (profile ${profile})` : ""}.`, {
      action: "close",
      target,
    });
  }
  if (target === "tabs") {
    const victims = [...session.tabs.values()].filter((tab) => tab.owned);
    for (const tab of victims) await session.closeTab(tab.handle);
    const infos = await session.listTabs();
    return finalize(
      `Closed ${victims.length} agent tab(s).\n\n${formatTabs(infos, config.maxTabs)}`,
      {
        action: "close",
        target,
        tabs: infos,
      },
    );
  }
  const handle = params.tab ?? session.current;
  if (handle === undefined) {
    throw new BrowserPilotError(
      "No tab is open to close.",
      'Use {action:"close", target:"browser"} to close the browser.',
    );
  }
  await session.closeTab(handle);
  const infos = await session.listTabs();
  return finalize(`Closed tab ${handle}.\n\n${formatTabs(infos, config.maxTabs)}`, {
    action: "close",
    target: "tab",
    tab: handle,
    tabs: infos,
  });
}

export async function connectResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const instance = await session.connectExternal(params.endpoint!);
  const infos = await session.listTabs();
  const current = infos.find((info) => info.current);
  const lines = [
    `Attached to ${instance.wsEndpoint}`,
    formatTabs(infos, session.config.maxTabs),
    "",
    hint("this browser is external; close disconnects without closing Chrome."),
  ];
  return finalize(lines.join("\n"), {
    action: "connect",
    tab: current?.handle,
    url: current?.url,
    title: current?.title,
    tabs: infos,
    endpoint: instance.wsEndpoint,
    external: true,
  });
}

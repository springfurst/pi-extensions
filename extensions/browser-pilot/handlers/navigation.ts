import { finalize, formatTabs, hint, pageHeader, suggestedNext } from "../output";
import type { BrowserPilotSession } from "../session";
import { appendChallenge } from "../tool-helpers";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotParams,
  BrowserPilotToolResult,
} from "../types";

export async function navigateResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const direction =
    params.direction === "back" || params.direction === "forward" || params.direction === "reload"
      ? params.direction
      : undefined;
  const nav = await session.navigate(
    params.url,
    direction,
    params.wait_until,
    params.timeout_ms,
    ctx.signal,
    params.tab,
  );
  return navigateText(nav);
}

export function navigateText(
  nav: Awaited<ReturnType<BrowserPilotSession["navigate"]>>,
  action = "navigate",
): BrowserPilotToolResult {
  const lines = [pageHeader(nav.tab.handle, nav.url, nav.title), `Status: ${nav.status}`];
  if (nav.note) lines.push(nav.note);
  appendChallenge(lines, nav.challenge);
  lines.push("", suggestedNext('{action:"snapshot"} or {action:"read"}.'));
  return finalize(lines.join("\n"), {
    action,
    tab: nav.tab.handle,
    url: nav.url,
    title: nav.title,
    status: nav.status,
    challenge: nav.challenge,
    tabs: undefined,
  });
}

export async function tabsResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const op = String(params.op);
  if (op === "list" && !session.instance) {
    return finalize("No browser is running.\n\n" + hint('call {action:"open"} first.'), {
      action: "tabs",
      op,
    });
  }
  await session.ensure();
  if (op === "new") {
    const tab = await session.newTab(params.url);
    const infos = await session.listTabs();
    const info = infos.find((candidate) => candidate.handle === tab.handle)!;
    return finalize(`Opened tab ${tab.handle}.\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tab: info.handle,
      url: info.url,
      title: info.title,
      tabs: infos,
    });
  }
  if (op === "select") {
    const info = await session.selectTab(params.tab!);
    return finalize(
      `Selected tab ${info.handle}.\n\n${pageHeader(info.handle, info.url, info.title)}`,
      {
        action: "tabs",
        op,
        tab: info.handle,
        url: info.url,
        title: info.title,
      },
    );
  }
  if (op === "close") {
    const handle = params.tab!;
    await session.closeTab(handle);
    const infos = await session.listTabs();
    return finalize(`Closed tab ${handle}.\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tab: handle,
      tabs: infos,
    });
  }
  if (op === "close_others") {
    const count = await session.closeOtherTabs();
    const infos = await session.listTabs();
    return finalize(`Closed ${count} other agent tab(s).\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tabs: infos,
    });
  }
  if (op === "cleanup") {
    const count = await session.cleanupTabs();
    const infos = await session.listTabs();
    return finalize(`Closed ${count} idle agent tab(s).\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tabs: infos,
    });
  }
  const infos = await session.listTabs();
  const current = infos.find((tab) => tab.current);
  return finalize(formatTabs(infos, config.maxTabs), {
    action: "tabs",
    op: "list",
    tabs: infos,
    tab: current?.handle,
    url: current?.url,
    title: current?.title,
  });
}

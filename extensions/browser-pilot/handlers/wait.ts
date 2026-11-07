import { detectChallenge, waitForHuman } from "../challenge";
import { NETWORK_BODY_PREVIEW_CHARS, readNetworkBody, waitForNetworkResponse } from "../network";
import { finalize, hint, pageHeader, truncationHint } from "../output";
import type { BrowserPilotSession } from "../session";
import {
  appendChallenge,
  indentText,
  locatorFor,
  resolveTargetSelector,
  sleep,
  targetFor,
} from "../tool-helpers";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotParams,
  BrowserPilotToolResult,
} from "../types";
import { BrowserPilotError } from "../types";

export async function waitResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const kind = params.for!;
  const timeout =
    params.timeout_ms ??
    (kind === "human" ? config.challengeWaitSeconds * 1000 : config.actionTimeoutSeconds * 1000);
  const started = Date.now();
  if (kind === "human") {
    let lastUpdate = 0;
    const result = await waitForHuman(tab.page, {
      timeoutMs: timeout,
      signal: ctx.signal,
      onProgress: (elapsed, challenge) => {
        if (Date.now() - lastUpdate < 5_000) return;
        lastUpdate = Date.now();
        if (challenge) session.challenge = challenge;
        void ctx.onUpdate?.({
          content: [
            {
              type: "text",
              text: `Waiting for human... ${Math.round(elapsed / 1000)}s`,
            },
          ],
          details: {
            action: "wait",
            tab: tab.handle,
            url: tab.page.url(),
            challenge: challenge ?? session.challenge,
          },
        });
      },
    });
    session.challenge = result.challenge;
    session.persist();
    if (!result.cleared) {
      throw new BrowserPilotError(
        `Timed out after ${Math.round(result.elapsedMs / 1000)}s waiting for the challenge to clear.`,
        'The challenge is still present. Solve it in the Chrome window, then run wait {for:"human"} again.',
      );
    }
    const text = result.initialChallenge
      ? `Challenge cleared after ${Math.round(result.elapsedMs / 1000)}s.`
      : `No blocking challenge was present after ${Math.round(result.elapsedMs / 1000)}s.`;
    return finalize(
      [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), text].join(
        "\n",
      ),
      {
        action: "wait",
        tab: tab.handle,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ""),
        challenge: result.challenge ?? result.initialChallenge,
        elapsedMs: result.elapsedMs,
      },
    );
  }

  if (kind === "response") {
    const entry = await waitForNetworkResponse(tab, params.url_pattern!, timeout, ctx.signal);
    const elapsed = Date.now() - started;
    const body = params.include_body
      ? await readNetworkBody(
          session,
          entry,
          session.networkDetail(entry.id)?.response,
          params.max_chars ?? NETWORK_BODY_PREVIEW_CHARS,
        )
      : undefined;
    const lines = [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Response ${entry.id} after ${elapsed}ms: ${entry.status ?? "..."} ${entry.method} ${entry.url}`,
    ];
    if (body?.text !== undefined) {
      lines.push("", "Body:", indentText(body.text));
      if (body.truncated) {
        lines.push(
          "",
          truncationHint(
            body.chars ?? body.text.length,
            params.max_chars ?? NETWORK_BODY_PREVIEW_CHARS,
            undefined,
            false,
          ),
        );
      }
    } else if (body?.note) {
      lines.push("", `Body: ${body.note}`);
    }
    lines.push("", hint(`use network {op:"get", id:"${entry.id}"} for headers and body.`));
    return finalize(lines.join("\n"), {
      action: "wait",
      tab: tab.handle,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      elapsedMs: elapsed,
      id: entry.id,
      response: entry,
      body: body?.text,
      truncated: body?.truncated,
    });
  }

  if (kind === "selector") {
    if (params.ref) {
      const handle = await locatorFor(session, tab, params, timeout)
        .setVisibility("visible")
        .waitHandle();
      await handle.dispose().catch(() => undefined);
    } else {
      await tab.page.waitForSelector(params.selector!, {
        visible: true,
        timeout,
        signal: ctx.signal,
      });
    }
  } else if (kind === "text") {
    await tab.page.waitForFunction(
      (needle) => (document.body?.innerText ?? "").includes(needle),
      { timeout, signal: ctx.signal },
      params.text!,
    );
  } else if (kind === "url") {
    await tab.page.waitForFunction(
      (needle) => location.href.includes(needle),
      { timeout, signal: ctx.signal },
      params.url!,
    );
  } else if (kind === "network_idle") {
    await tab.page.waitForNetworkIdle({ idleTime: 500, timeout, signal: ctx.signal });
  } else if (kind === "function") {
    await tab.page.waitForFunction(`() => { return (${params.expression!}); }`, {
      timeout,
      signal: ctx.signal,
    });
  }
  tab.lastUsed = Date.now();
  session.persist();
  const elapsed = Date.now() - started;
  const challenge = await detectChallenge(tab.page).catch(() => undefined);
  session.challenge = challenge;
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Wait satisfied after ${elapsed}ms.`,
  ];
  appendChallenge(lines, challenge);
  return finalize(lines.join("\n"), {
    action: "wait",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    elapsedMs: elapsed,
    challenge,
  });
}

export async function expectResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const operator =
    params.operator ??
    (params.check === "text" || params.check === "title" ? "contains" : "equals");
  const expected =
    params.expected ??
    (params.check === "selector" || params.check === "visible" || params.check === "hidden"
      ? "true"
      : "");
  const started = Date.now();
  let actual = "";
  let passed = false;
  let lastError: string | undefined;
  while (true) {
    try {
      actual = await readExpectationValue(params, session, tab, timeout);
      lastError = undefined;
      passed = compareExpectation(actual, expected, operator);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      actual = "";
      passed = false;
    }
    if (passed || Date.now() - started >= timeout) break;
    await sleep(100);
    ctx.signal?.throwIfAborted();
  }
  if (!passed) {
    throw new BrowserPilotError(
      `expect ${params.check} failed: expected ${operator} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.${lastError ? ` Last error: ${lastError}` : ""}`,
      "Inspect the page with snapshot or read, then retry with a longer timeout_ms if the page is still loading.",
    );
  }
  tab.lastUsed = Date.now();
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `expect ${params.check}: ${operator} ${JSON.stringify(expected)} passed.`,
      `Actual: ${JSON.stringify(actual)}`,
    ].join("\n"),
    {
      action: "expect",
      tab: tab.handle,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      check: params.check,
      operator,
      expected,
      actual,
      elapsedMs: Date.now() - started,
    },
  );
}

interface ElementSnapshot {
  exists: boolean;
  visible: boolean;
  value: string;
  attribute: string | null;
}

const MISSING_ELEMENT: ElementSnapshot = {
  exists: false,
  visible: false,
  value: "",
  attribute: null,
};

async function readElementSnapshot(
  target: ReturnType<typeof targetFor>,
  selector: string,
  useLocator: boolean,
  timeoutMs: number,
  attribute: string | undefined,
): Promise<ElementSnapshot> {
  const describe = (element: Element, name: string | undefined): ElementSnapshot => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0;
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : ((element as HTMLElement).innerText ?? element.textContent ?? "");
    return {
      exists: true,
      visible,
      value,
      attribute: name === undefined ? null : element.getAttribute(name),
    };
  };
  if (useLocator) {
    const perPollTimeout = Math.max(100, Math.min(timeoutMs, 500));
    try {
      const handle = await target.locator(selector).setTimeout(perPollTimeout).waitHandle();
      try {
        return await handle.evaluate(describe, attribute);
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    } catch {
      return MISSING_ELEMENT;
    }
  }
  return target.evaluate(
    (value, name) => {
      const element = document.querySelector(value);
      if (!element) {
        return { exists: false, visible: false, value: "", attribute: null };
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0;
      const text =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.value
          : ((element as HTMLElement).innerText ?? element.textContent ?? "");
      return {
        exists: true,
        visible,
        value: text,
        attribute: name === undefined ? null : element.getAttribute(name),
      };
    },
    selector,
    attribute,
  );
}

export async function readExpectationValue(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  timeoutMs = 1_000,
): Promise<string> {
  if (params.check === "text") {
    return tab.page.evaluate(() => document.body?.innerText ?? "");
  }
  if (params.check === "url") return tab.page.url();
  if (params.check === "title") return tab.page.title();
  const target = targetFor(session, tab, params);
  const selector = resolveTargetSelector(params);
  const useLocator = params.ref !== undefined;
  if (params.check === "selector") {
    if (useLocator) {
      const state = await readElementSnapshot(target, selector, true, timeoutMs, params.attribute);
      return String(state.exists);
    }
    const found = await target.evaluate(
      (value) => document.querySelector(value) !== null,
      selector,
    );
    return String(found);
  }
  if (params.check === "count") {
    if (useLocator) {
      const state = await readElementSnapshot(target, selector, true, timeoutMs, params.attribute);
      return String(state.exists ? 1 : 0);
    }
    const count = await target.evaluate(
      (value) => document.querySelectorAll(value).length,
      selector,
    );
    return String(count);
  }
  const state = await readElementSnapshot(
    target,
    selector,
    useLocator,
    timeoutMs,
    params.attribute,
  );
  if (params.check === "visible") return String(state.visible);
  if (params.check === "hidden") return String(!state.visible);
  if (params.check === "attribute") return state.attribute ?? "";
  return state.value;
}

export function compareExpectation(actual: string, expected: string, operator: string): boolean {
  if (operator === "contains") return actual.includes(expected);
  if (operator === "not_contains") return !actual.includes(expected);
  if (operator === "matches") {
    try {
      return new RegExp(expected).test(actual);
    } catch {
      return false;
    }
  }
  if (operator === "gt" || operator === "lt" || operator === "gte" || operator === "lte") {
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === "gt") return left > right;
    if (operator === "lt") return left < right;
    if (operator === "gte") return left >= right;
    return left <= right;
  }
  if (operator === "not_equals") return actual !== expected;
  return actual === expected;
}

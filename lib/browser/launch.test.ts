import { describe, expect, it } from "vitest";
import { decideExistingInstance } from "./launch";
import type { InstanceRecord } from "./profile";

const record: InstanceRecord = {
  schema: 1,
  pid: 4242,
  port: 9333,
  wsEndpoint: "ws://127.0.0.1:9333/devtools/browser/abc",
  userDataDir: "/tmp/profile",
  executablePath: "/usr/bin/chrome",
  startedAt: "2026-11-20T00:00:00.000Z",
  ownerSessionId: "session-a",
};

describe("decideExistingInstance", () => {
  it("ignores a missing record", () => {
    expect(
      decideExistingInstance({ record: undefined, sessionId: "a", attach: true, alive: false }),
    ).toEqual({ action: "ignore" });
  });

  it("ignores a record whose process is gone", () => {
    expect(decideExistingInstance({ record, sessionId: "a", attach: true, alive: false })).toEqual({
      action: "ignore",
    });
  });

  it("reuses a live endpoint for the same profile", () => {
    const decision = decideExistingInstance({
      record,
      sessionId: "session-b",
      attach: true,
      alive: true,
      probe: { wsEndpoint: record.wsEndpoint, chromeVersion: "Chrome/140" },
    });
    expect(decision.action).toBe("reuse");
    if (decision.action !== "reuse") throw new Error("expected reuse");
    expect(decision.instance.chromeVersion).toBe("Chrome/140");
  });

  it("attaches to another session's browser when attach is enabled", () => {
    const decision = decideExistingInstance({
      record,
      sessionId: "session-b",
      attach: true,
      alive: true,
    });
    expect(decision.action).toBe("reuse");
  });

  it("ignores a port that now serves a different browser", () => {
    const decision = decideExistingInstance({
      record,
      sessionId: "session-a",
      attach: true,
      alive: true,
      probe: { wsEndpoint: "ws://127.0.0.1:9333/devtools/browser/other" },
    });
    expect(decision.action).toBe("ignore");
  });

  it("refuses another session's browser when attach is disabled", () => {
    expect(
      decideExistingInstance({ record, sessionId: "session-b", attach: false, alive: true }),
    ).toEqual({ action: "refuse", instance: record });
  });

  it("replaces a dead endpoint owned by this session when attach is disabled", () => {
    expect(
      decideExistingInstance({ record, sessionId: "session-a", attach: false, alive: true }),
    ).toEqual({ action: "kill", instance: record });
  });

  it("treats a record without an owner as this session's", () => {
    const unowned = { ...record, ownerSessionId: "" };
    expect(
      decideExistingInstance({
        record: unowned,
        sessionId: "session-b",
        attach: false,
        alive: true,
      }).action,
    ).toBe("kill");
  });
});

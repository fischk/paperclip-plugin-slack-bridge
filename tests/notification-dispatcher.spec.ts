import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostCallFailureSuppression } from "../src/host-errors.js";
import { dispatchPaperclipEvent } from "../src/notification-dispatcher.js";
import type { SlackNotificationsConfig } from "../src/types.js";

const slackApiMock = vi.hoisted(() => ({
  postMessage: vi.fn(async () => ({ ok: true, ts: "123.456" })),
}));

vi.mock("../src/slack-api.js", () => slackApiMock);

const config: SlackNotificationsConfig = {
  defaultChannelId: "C0000000000",
  paperclipBaseUrl: "http://127.0.0.1:3100",
  notifyApprovalCreated: true,
};

const scopeDenied = new Error('Plugin "plugin-1" is not allowed to perform "state.get": the worker referenced a missing, expired, or unknown invocation scope');

function approvalEvent(id: string): PluginEvent {
  return {
    eventId: `evt-${id}`,
    eventType: "approval.created",
    occurredAt: "2026-06-28T00:00:00.000Z",
    actorId: "test",
    actorType: "plugin",
    entityId: id,
    entityType: "approval",
    companyId: "company-1",
    payload: {
      approvalId: id,
      companyPrefix: "COM",
      type: "request_board_approval",
      title: "Board Approval: Scheduled poll proof",
      summary: "Proof that scheduled jobs do not need plugin state scope to post.",
    },
  } as PluginEvent;
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      get: vi.fn(async () => { throw new Error("state.get should not be called"); }),
      set: vi.fn(async () => { throw new Error("state.set should not be called"); }),
    },
    http: { fetch: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    activity: { log: vi.fn(async () => undefined) },
    metrics: { write: vi.fn(async () => undefined) },
    ...overrides,
  } as any;
}

describe("dispatchPaperclipEvent", () => {
  beforeEach(() => {
    resetHostCallFailureSuppression();
    slackApiMock.postMessage.mockClear();
  });

  it("posts scheduled-job notifications without touching plugin state", async () => {
    const context = ctx();
    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalEvent("approval-memory-1"), { stateMode: "memory" });

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000", ts: "123.456" });
    expect(context.state.get).not.toHaveBeenCalled();
    expect(context.state.set).not.toHaveBeenCalled();
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it("dedupes memory-mode events within the worker process", async () => {
    const first = await dispatchPaperclipEvent(ctx(), "xoxb-redacted", config, approvalEvent("approval-memory-2"), { stateMode: "memory" });
    const second = await dispatchPaperclipEvent(ctx(), "xoxb-redacted", config, approvalEvent("approval-memory-2"), { stateMode: "memory" });

    expect(first.posted).toBe(true);
    expect(second).toMatchObject({ posted: false, reason: "duplicate" });
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it("uses persistent dedupe in best-effort mode when state is available", async () => {
    const context = ctx({
      state: {
        get: vi.fn(async () => ({ seenAt: "2026-06-28T00:00:00.000Z", source: "paperclip", effect: "posted" })),
        set: vi.fn(async () => undefined),
      },
    });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalEvent("approval-best-effort-seen"), { stateMode: "best-effort-persistent" });

    expect(result).toMatchObject({ posted: false, reason: "duplicate" });
    expect(context.state.get).toHaveBeenCalled();
    expect(context.state.set).not.toHaveBeenCalled();
    expect(slackApiMock.postMessage).not.toHaveBeenCalled();
  });

  it("falls back to configured-channel memory dispatch in best-effort mode when state is unavailable", async () => {
    const context = ctx();

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalEvent("approval-best-effort-fallback"), { stateMode: "best-effort-persistent" });

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000", ts: "123.456" });
    expect(context.state.get).toHaveBeenCalled();
    expect(context.state.set).toHaveBeenCalled();
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it("records classified state failures while posting best-effort notifications", async () => {
    const context = ctx({
      state: {
        get: vi.fn(async () => { throw scopeDenied; }),
        set: vi.fn(async () => { throw scopeDenied; }),
      },
    });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalEvent("approval-best-effort-scope-denied"), { stateMode: "best-effort-persistent" });

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000", ts: "123.456" });
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
    expect(context.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "poller_dispatch",
      method: "state.get",
      error_kind: "scope-denied",
    }));
    expect(context.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "poller_dispatch",
      method: "state.set",
      error_kind: "scope-denied",
    }));
  });
});

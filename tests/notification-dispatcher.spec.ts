import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostCallFailureSuppression } from "../src/host-errors.js";
import { dispatchPaperclipEvent } from "../src/notification-dispatcher.js";
import type { SlackNotificationsConfig } from "../src/types.js";

const slackApiMock = vi.hoisted(() => ({
  postMessage: vi.fn(async () => ({ ok: true, ts: "123.456" })),
  updateMessage: vi.fn(async () => ({ ok: true })),
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

function approvalDecidedEvent(id: string): PluginEvent {
  return {
    ...approvalEvent(id),
    eventId: `evt-decided-${id}`,
    eventType: "approval.decided",
    payload: { approvalId: id, companyPrefix: "COM", title: "Board Approval: Scheduled poll proof", status: "approved" },
  } as PluginEvent;
}

const storedCard = { channelId: "C-approvals", ts: "111.222", createdAt: "2026-06-28T00:00:00.000Z" };

/** Only the approval-card key resolves, so dedupe and issue-thread reads stay empty. */
function approvalCardState(card: typeof storedCard | null = storedCard) {
  return {
    get: vi.fn(async (scope: { namespace: string; stateKey: string }) =>
      scope.namespace === "threads" && scope.stateKey.startsWith("approval.") ? card : null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      get: vi.fn(async () => { throw new Error("state.get should not be called"); }),
      set: vi.fn(async () => { throw new Error("state.set should not be called"); }),
      delete: vi.fn(async () => { throw new Error("state.delete should not be called"); }),
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
    slackApiMock.updateMessage.mockClear();
    slackApiMock.updateMessage.mockImplementation(async () => ({ ok: true }));
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
  it("stores the approval card so a later decision can find it", async () => {
    const context = ctx({ state: approvalCardState(null) });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalEvent("approval-card-ref"));

    expect(result).toMatchObject({ posted: true, reason: "posted" });
    expect(context.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "company", scopeId: "company-1", namespace: "threads", stateKey: "approval.approval-card-ref" }),
      expect.objectContaining({ channelId: "C0000000000", ts: "123.456" }),
    );
  });

  it("still posts the approval card when the card ref cannot be stored", async () => {
    const context = ctx({
      state: {
        get: vi.fn(async () => null),
        // Only the card ref is unwritable; dedupe state still works.
        set: vi.fn(async (scope: { stateKey: string }) => {
          if (scope.stateKey.startsWith("approval.")) throw scopeDenied;
        }),
      },
    });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalEvent("approval-card-ref-unwritable"));

    expect(result).toMatchObject({ posted: true, reason: "posted", ts: "123.456" });
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it("updates the original approval card when a decision arrives", async () => {
    const context = ctx({ state: approvalCardState() });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-1"));

    expect(result).toMatchObject({ posted: true, reason: "updated", channelId: "C-approvals", ts: "111.222" });
    expect(slackApiMock.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApiMock.updateMessage).toHaveBeenCalledWith(context, "xoxb-redacted", "C-approvals", "111.222", expect.objectContaining({ text: expect.stringContaining("✅ Approved") }));
    expect(slackApiMock.postMessage).not.toHaveBeenCalled();
    expect(context.activity.log).toHaveBeenCalledWith(expect.objectContaining({ message: "Forwarded approval.decided to Slack" }));
  });

  it("posts a new message when no approval card was stored", async () => {
    const context = ctx({ state: approvalCardState(null) });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-2"));

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000" });
    expect(slackApiMock.updateMessage).not.toHaveBeenCalled();
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
    expect(context.activity.log).toHaveBeenCalledWith(expect.objectContaining({ message: "Forwarded approval.decided to Slack" }));
  });

  it("posts a new message when the card update is rejected by Slack", async () => {
    slackApiMock.updateMessage.mockImplementation(async () => ({ ok: false, error: "message_not_found" }));
    const context = ctx({ state: approvalCardState() });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-3"));

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000" });
    expect(slackApiMock.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it("posts a new message when the approval card lookup fails", async () => {
    const context = ctx({
      state: {
        get: vi.fn(async () => { throw scopeDenied; }),
        set: vi.fn(async () => undefined),
      },
    });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-4"), { stateMode: "best-effort-persistent" });

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000" });
    expect(slackApiMock.updateMessage).not.toHaveBeenCalled();
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });
  it("clears the card ref once the approval is resolved in place", async () => {
    const context = ctx({ state: approvalCardState() });

    await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-5"));

    expect(context.state.delete).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "company", namespace: "threads", stateKey: "approval.approval-decided-5" }),
    );
  });

  it("posts a new message when the card update throws instead of returning an error", async () => {
    slackApiMock.updateMessage.mockImplementation(async () => { throw new Error("socket hang up"); });
    const context = ctx({ state: approvalCardState() });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-6"));

    expect(result).toMatchObject({ posted: true, reason: "posted", channelId: "C0000000000" });
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
  });

  it("still resolves the card when clearing the ref afterwards fails", async () => {
    const state = approvalCardState();
    state.delete = vi.fn(async () => { throw scopeDenied; });
    const context = ctx({ state });

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-7"));

    expect(result).toMatchObject({ posted: true, reason: "updated", channelId: "C-approvals" });
    expect(slackApiMock.postMessage).not.toHaveBeenCalled();
  });
  it("leaves the card alone when a decided approval still reads as pending", async () => {
    const context = ctx({ state: approvalCardState() });
    const event = { ...approvalDecidedEvent("approval-decided-8"), payload: { approvalId: "approval-decided-8", companyPrefix: "COM", title: "Board Approval", status: "pending" } } as PluginEvent;

    const result = await dispatchPaperclipEvent(context, "xoxb-redacted", config, event);

    expect(result).toMatchObject({ posted: false, reason: "approval-still-pending" });
    expect(slackApiMock.updateMessage).not.toHaveBeenCalled();
    expect(slackApiMock.postMessage).not.toHaveBeenCalled();
    expect(context.state.delete).not.toHaveBeenCalled();
  });

  it("tags thrown card-update failures with a bounded metric value", async () => {
    slackApiMock.updateMessage.mockImplementation(async () => { throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:3100"); });
    const context = ctx({ state: approvalCardState() });

    await dispatchPaperclipEvent(context, "xoxb-redacted", config, approvalDecidedEvent("approval-decided-9"));

    expect(context.metrics.write).toHaveBeenCalledWith("slack_approval_card_update_failed", 1, expect.objectContaining({ error_code: "exception" }));
  });
});

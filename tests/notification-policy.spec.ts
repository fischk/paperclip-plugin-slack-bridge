import { describe, expect, it, vi } from "vitest";
import { isNotificationEnabled, resolveDestination } from "../src/notification-policy.js";
import type { NormalizedNotification, SlackNotificationsConfig } from "../src/types.js";

const config: SlackNotificationsConfig = {
  slackBotTokenRef: "secret-bot",
  defaultChannelId: "C-default",
  approvalsChannelId: "C-approvals",
  errorsChannelId: "C-errors",
};

const notification: NormalizedNotification = {
  kind: "approval.created",
  eventId: "evt-1",
  eventType: "approval.created",
  occurredAt: "2026-06-27T00:00:00.000Z",
  companyId: "company-1",
  entityId: "approval-1",
  approvalId: "approval-1",
  issueId: "issue-1",
  title: "Approval requested",
  raw: {} as NormalizedNotification["raw"],
};

describe("notification policy", () => {
  it("respects config booleans", () => {
    expect(isNotificationEnabled(notification, { ...config, notifyApprovalCreated: false })).toBe(false);
    expect(isNotificationEnabled(notification, config)).toBe(true);
  });

  it("prefers linked issue thread over per-type channel", async () => {
    const ctx = {
      state: {
        get: vi.fn(async () => ({ channelId: "C-thread", threadTs: "123.4", createdAt: "now", updatedAt: "now" })),
      },
    };
    await expect(resolveDestination(ctx as never, notification, config)).resolves.toEqual({ channelId: "C-thread", threadTs: "123.4", reason: "linked-thread" });
  });

  it("falls back to per-type then default channel", async () => {
    const ctx = { state: { get: vi.fn(async () => null) } };
    await expect(resolveDestination(ctx as never, notification, config)).resolves.toEqual({ channelId: "C-approvals", reason: "per-type-channel" });
    await expect(resolveDestination(ctx as never, { ...notification, kind: "issue.completed" }, config)).resolves.toEqual({ channelId: "C-default", reason: "default-channel" });
  });
});

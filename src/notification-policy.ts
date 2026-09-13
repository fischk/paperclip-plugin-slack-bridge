import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Destination, NormalizedNotification, SlackNotificationsConfig } from "./types.js";
import { getIssueThread } from "./state.js";

export function isNotificationEnabled(notification: NormalizedNotification, config: SlackNotificationsConfig): boolean {
  switch (notification.kind) {
    case "approval.created": return config.notifyApprovalCreated ?? true;
    case "human.input_needed": return config.notifyHumanInputNeeded ?? true;
    case "run.failed": return config.notifyRunFailed ?? false;
    case "run.finished": return config.notifyRunFinished ?? false;
    case "issue.assigned": return config.notifyIssueAssigned ?? false;
    case "issue.blocked":
    case "issue.unblocked": return config.notifyIssueBlocked ?? false;
    case "issue.completed": return config.notifyIssueCompleted ?? false;
    default: return true;
  }
}

export async function resolveDestination(
  ctx: Pick<PluginContext, "state">,
  notification: NormalizedNotification,
  config: SlackNotificationsConfig,
): Promise<Destination | null> {
  if (notification.issueId && usesIssueThread(notification)) {
    const linked = await getIssueThread(ctx, notification.issueId);
    if (linked) return { channelId: linked.channelId, threadTs: linked.threadTs, reason: "linked-thread" };
  }

  return resolveConfiguredDestination(notification, config);
}

export function resolveConfiguredDestination(
  notification: NormalizedNotification,
  config: SlackNotificationsConfig,
): Destination | null {
  const perType = perTypeChannel(notification, config);
  if (perType) return { channelId: perType, reason: "per-type-channel" };
  if (config.defaultChannelId) return { channelId: config.defaultChannelId, reason: "default-channel" };
  return null;
}

/**
 * An approval is a decision surface, not a conversation turn, so it neither joins nor starts
 * an issue thread. Threading it buries it wherever the issue is long-lived: every approval
 * raised against a standing ledger issue lands as a reply under the first card ever posted for
 * it, invisible to anyone reading the channel. And an approval card that became the thread
 * would pull the issue's later notifications, run failures included, into the approvals
 * channel.
 */
export function usesIssueThread(notification: NormalizedNotification): boolean {
  return !isApproval(notification);
}

function isApproval(notification: NormalizedNotification): boolean {
  return notification.kind.startsWith("approval.");
}

function perTypeChannel(notification: NormalizedNotification, config: SlackNotificationsConfig): string | undefined {
  if (isApproval(notification)) return config.approvalsChannelId || undefined;
  if (notification.kind === "run.failed") return config.errorsChannelId || undefined;
  if (notification.kind === "run.finished") return config.runsChannelId || undefined;
  return undefined;
}

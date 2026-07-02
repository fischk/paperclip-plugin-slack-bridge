import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_PAPERCLIP_BASE_URL } from "./constants.js";
import { normalizeEvent } from "./event-normalizers.js";
import { recordHostCallFailure, type HostCallSurface } from "./host-errors.js";
import { renderNotification } from "./block-kit/index.js";
import { postMessage } from "./slack-api.js";
import { hasSeenEvent, markEventSeen, getIssueThread, setIssueThread } from "./state.js";
import { isNotificationEnabled, resolveConfiguredDestination, resolveDestination } from "./notification-policy.js";
import type { DispatchResult, NormalizedNotification, SlackNotificationsConfig, SlackThreadRef } from "./types.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

type DispatchStateMode = "persistent" | "memory" | "best-effort-persistent";

export interface DispatchOptions {
  /**
   * Normal event handlers use persistent state so notifications survive worker
   * restarts. Scheduled reconciliation jobs may not always receive state scope,
   * so they can use best-effort-persistent: try ctx.state first, then degrade to
   * in-process memory if the host denies state access.
   */
  stateMode?: DispatchStateMode;
}

const MEMORY_SEEN_LIMIT = 2_000;
const memorySeenEvents = new Map<string, number>();

export async function dispatchPaperclipEvent(
  ctx: Pick<PluginContext, "state" | "http" | "logger" | "activity" | "metrics">,
  access: string,
  config: SlackNotificationsConfig,
  event: PluginEvent,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const notification = normalizeEvent(event, config.paperclipBaseUrl || DEFAULT_PAPERCLIP_BASE_URL);
  if (!notification) return { posted: false, reason: "unsupported-event" };
  if (!isNotificationEnabled(notification, config)) return { posted: false, reason: "disabled" };

  const stateMode = options.stateMode ?? "persistent";
  const eventKey = notification.eventId;
  if (await hasSeen(ctx, notification.companyId, eventKey, stateMode)) {
    return { posted: false, reason: "duplicate" };
  }

  const destination = await resolveDispatchDestination(ctx, notification, config, stateMode);
  if (!destination) {
    await markSeen(ctx, notification.companyId, eventKey, "no-destination", stateMode);
    return { posted: false, reason: "no-destination" };
  }

  const message = renderNotification(notification, config);
  const result = await postMessage(ctx, access, destination.channelId, message, destination.threadTs ? { threadTs: destination.threadTs } : undefined);
  if (!result.ok) {
    writeMetricBestEffort(ctx, "slack_notifications_failed", { event_type: notification.eventType, error_code: result.error ?? "unknown" });
    return { posted: false, reason: result.error ?? "slack-error", channelId: destination.channelId };
  }

  await markSeen(ctx, notification.companyId, eventKey, "posted", stateMode);
  if ((stateMode === "persistent" || stateMode === "best-effort-persistent") && notification.issueId && result.ts) {
    const now = new Date().toISOString();
    const existing = await getIssueThreadBestEffort(ctx, notification.issueId, stateMode);
    await setIssueThreadBestEffort(ctx, notification.issueId, {
      channelId: destination.channelId,
      threadTs: destination.threadTs ?? existing?.threadTs ?? result.ts,
      rootMessageTs: existing?.rootMessageTs ?? destination.threadTs ?? result.ts,
      lastCardTs: result.ts,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }, stateMode);
  }

  try {
    await ctx.activity.log({
      companyId: notification.companyId,
      message: `Forwarded ${notification.kind} to Slack`,
      entityType: notification.raw.entityType ?? "plugin",
      entityId: notification.entityId,
      metadata: { slackChannelId: destination.channelId, slackTs: result.ts, destinationReason: destination.reason, stateMode },
    });
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, dispatchSurface(stateMode), "activity.log", error);
    ctx.logger.warn("Slack notification activity log failed", { companyId: notification.companyId, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
  }
  writeMetricBestEffort(ctx, "slack_notifications_sent", { event_type: notification.eventType, kind: notification.kind });

  return { posted: true, reason: "posted", channelId: destination.channelId, ts: result.ts, threadTs: destination.threadTs };
}

async function resolveDispatchDestination(
  ctx: Pick<PluginContext, "state" | "metrics" | "logger">,
  notification: NormalizedNotification,
  config: SlackNotificationsConfig,
  stateMode: DispatchStateMode,
) {
  if (stateMode === "memory") return resolveConfiguredDestination(notification, config);
  if (stateMode === "persistent") return resolveDestination(ctx, notification, config);
  try {
    return await resolveDestination(ctx, notification, config);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, dispatchSurface(stateMode), "state.get", error);
    ctx.logger.warn("Slack notification destination state lookup failed; using configured channel", { companyId: notification.companyId, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return resolveConfiguredDestination(notification, config);
  }
}

async function getIssueThreadBestEffort(
  ctx: Pick<PluginContext, "state" | "metrics" | "logger">,
  issueId: string,
  stateMode: DispatchStateMode,
): Promise<SlackThreadRef | null> {
  if (stateMode === "memory") return null;
  try {
    return await getIssueThread(ctx, issueId);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, dispatchSurface(stateMode), "state.get", error);
    ctx.logger.warn("Slack issue thread state lookup failed", { issueId, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    if (stateMode === "persistent") throw new Error("Failed to read Slack issue thread state");
    return null;
  }
}

async function setIssueThreadBestEffort(
  ctx: Pick<PluginContext, "state" | "metrics" | "logger">,
  issueId: string,
  ref: SlackThreadRef,
  stateMode: DispatchStateMode,
): Promise<void> {
  if (stateMode === "memory") return;
  try {
    await setIssueThread(ctx, issueId, ref);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, dispatchSurface(stateMode), "state.set", error);
    ctx.logger.warn("Slack issue thread state write failed", { issueId, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    if (stateMode === "persistent") throw new Error("Failed to write Slack issue thread state");
  }
}

async function hasSeen(
  ctx: Pick<PluginContext, "state" | "metrics" | "logger">,
  companyId: string,
  eventKey: string,
  stateMode: DispatchStateMode,
): Promise<boolean> {
  const memoryKey = memorySeenKey(companyId, eventKey);
  if (stateMode === "persistent") {
    const seen = await hasSeenEvent(ctx, companyId, eventKey);
    return seen || memorySeenEvents.has(memoryKey);
  }
  if (stateMode === "best-effort-persistent") {
    try {
      const seen = await hasSeenEvent(ctx, companyId, eventKey);
      if (seen) {
        memorySeenEvents.set(memoryKey, Date.now());
        trimMemorySeenEvents();
        return true;
      }
    } catch (error) {
      const errorKind = recordHostCallFailure(ctx, dispatchSurface(stateMode), "state.get", error);
      ctx.logger.warn("Slack notification dedupe state lookup failed; using in-memory fallback", { companyId, eventKey, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return memorySeenEvents.has(memoryKey);
}

async function markSeen(
  ctx: Pick<PluginContext, "state" | "metrics" | "logger">,
  companyId: string,
  eventKey: string,
  reason: string,
  stateMode: DispatchStateMode,
): Promise<void> {
  const memoryKey = memorySeenKey(companyId, eventKey);
  if (stateMode === "persistent") {
    await markEventSeen(ctx, companyId, eventKey, reason);
    memorySeenEvents.set(memoryKey, Date.now());
    trimMemorySeenEvents();
    return;
  }
  if (stateMode === "best-effort-persistent") {
    try {
      await markEventSeen(ctx, companyId, eventKey, reason);
    } catch (error) {
      const errorKind = recordHostCallFailure(ctx, dispatchSurface(stateMode), "state.set", error);
      ctx.logger.warn("Slack notification dedupe state write failed; using in-memory fallback", { companyId, eventKey, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    }
  }
  memorySeenEvents.set(memoryKey, Date.now());
  trimMemorySeenEvents();
}

function dispatchSurface(stateMode: DispatchStateMode): HostCallSurface {
  return stateMode === "best-effort-persistent" ? "poller_dispatch" : "event_dispatch";
}

function writeMetricBestEffort(ctx: Pick<PluginContext, "metrics" | "logger">, name: string, tags: Record<string, string>): void {
  void ctx.metrics.write(name, 1, tags).catch((error: unknown) => {
    ctx.logger.warn("Failed to write Slack notification metric", { metric: name, error: error instanceof Error ? error.message : String(error) });
  });
}

function memorySeenKey(companyId: string, eventKey: string): string {
  return `${companyId}:${eventKey}`;
}

function trimMemorySeenEvents(): void {
  if (memorySeenEvents.size <= MEMORY_SEEN_LIMIT) return;
  while (memorySeenEvents.size > MEMORY_SEEN_LIMIT) {
    const oldest = memorySeenEvents.keys().next().value;
    if (!oldest) break;
    memorySeenEvents.delete(oldest);
  }
}

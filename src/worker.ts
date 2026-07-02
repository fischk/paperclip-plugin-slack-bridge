import { definePlugin, runWorker, type PluginContext, type PluginEvent } from "@paperclipai/plugin-sdk";
import { classifyHostError, recordHostCallFailure, type HostCallMethod, type HostErrorKind } from "./host-errors.js";
import { dispatchPaperclipEvent } from "./notification-dispatcher.js";
import { approvalCreatedEventFromApi, failureSourceFor, isRestFetchError, pollHumanLoopAttention, type PollFailureSource } from "./human-loop-poller.js";
import { startSlackSocketMode, type SocketModeRuntime } from "./socket-mode.js";
import type { RuntimeSlackCredentials, SlackNotificationsConfig } from "./types.js";

let currentConfig: SlackNotificationsConfig | null = null;
let currentCredentials: RuntimeSlackCredentials | null = null;
let currentSocket: SocketModeRuntime | null = null;
let runtimeCtx: PluginContext | null = null;

// REST-drift canary: the poller calls Paperclip's unversioned REST API directly.
// When every REST read fails for several consecutive cycles, the most likely cause
// is core changing those endpoints — surface it via health instead of warn logs.
let consecutivePollFailures = 0;
let lastPollFailureSource: PollFailureSource = "unknown";
let lastPollErrorKind: HostErrorKind = "unknown";
const POLL_FAILURE_HEALTH_THRESHOLD = 3;

function normalizeConfig(config: Record<string, unknown>): SlackNotificationsConfig {
  return {
    slackBotToken: optionalString(config.slackBotToken),
    slackAppToken: optionalString(config.slackAppToken),
    slackBotTokenRef: optionalString(config.slackBotTokenRef),
    slackAppTokenRef: optionalString(config.slackAppTokenRef),
    defaultChannelId: String(config.defaultChannelId ?? ""),
    defaultCompanyId: optionalString(config.defaultCompanyId),
    operatorUserId: optionalString(config.operatorUserId),
    approvalsChannelId: optionalString(config.approvalsChannelId),
    errorsChannelId: optionalString(config.errorsChannelId),
    runsChannelId: optionalString(config.runsChannelId),
    paperclipBaseUrl: optionalString(config.paperclipBaseUrl),
    paperclipApiToken: optionalString(config.paperclipApiToken),
    socketModeEnabled: bool(config.socketModeEnabled, true),
    humanLoopPollEnabled: bool(config.humanLoopPollEnabled, true),
    notifyHumanInputNeeded: bool(config.notifyHumanInputNeeded, true),
    notifyIssueAssigned: bool(config.notifyIssueAssigned, false),
    notifyIssueBlocked: bool(config.notifyIssueBlocked, false),
    notifyApprovalCreated: bool(config.notifyApprovalCreated, true),
    notifyRunFailed: bool(config.notifyRunFailed, false),
    notifyRunFinished: bool(config.notifyRunFinished, false),
    notifyIssueCompleted: bool(config.notifyIssueCompleted, false),
  };
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isMaskedCredential(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed === "***" || trimmed === "***REDACTED***" || trimmed === "[REDACTED]";
}

function usableCredential(value: string | undefined): string | undefined {
  return value && !isMaskedCredential(value) ? value : undefined;
}

// Resolution order: raw config value → secret ref → env var. Masked host echoes
// ("***") count as absent at every step so a real credential further down still wins.
// ponytail: env vars are a local-dev convenience only; plugin config is the real path
async function resolveCredential(ctx: PluginContext, rawValue?: string, ref?: string, envVar?: string): Promise<string | undefined> {
  const raw = usableCredential(rawValue);
  if (raw) return raw;
  if (ref && !isMaskedCredential(ref)) {
    const resolved = usableCredential(await ctx.secrets.resolve(ref));
    if (resolved) return resolved;
  }
  return envVar ? usableCredential(optionalString(process.env[envVar])) : undefined;
}

async function loadRuntimeConfig(ctx: PluginContext, override?: Record<string, unknown>): Promise<SlackNotificationsConfig> {
  const config = normalizeConfig(override ?? await ctx.config.get());
  config.defaultChannelId = config.defaultChannelId || optionalString(process.env.PAPERCLIP_SLACK_DEFAULT_CHANNEL_ID) || "";
  config.paperclipApiToken = await resolveCredential(ctx, config.paperclipApiToken, undefined, "PAPERCLIP_API_TOKEN");
  const botToken = await resolveCredential(ctx, config.slackBotToken, config.slackBotTokenRef, "PAPERCLIP_SLACK_BOT_TOKEN");
  const appToken = await resolveCredential(ctx, config.slackAppToken, config.slackAppTokenRef, "PAPERCLIP_SLACK_APP_TOKEN");
  if (!botToken) throw new Error("Missing Slack bot token");
  currentConfig = config;
  currentCredentials = { botToken, appToken };
  return config;
}

async function restartSocketMode(ctx: PluginContext): Promise<void> {
  await stopSocketMode();
  const config = currentConfig ?? await loadRuntimeConfig(ctx);
  const credentials = currentCredentials;
  if (!credentials?.botToken) throw new Error("Missing Slack bot token");
  if (!config.socketModeEnabled) return;
  if (!credentials.appToken) {
    ctx.logger.warn("Slack Socket Mode not started because slackAppToken is missing");
    return;
  }
  currentSocket = await startSlackSocketMode(ctx, config, credentials.botToken, credentials.appToken);
}

async function stopSocketMode(): Promise<void> {
  const socket = currentSocket;
  currentSocket = null;
  if (socket) await socket.stop();
}

// If the initial Socket Mode start failed (Slack outage, bad xapp token), the SDK's
// auto-reconnect never engages — it only covers connections that once succeeded.
// ponytail: piggybacks on the 1-minute job instead of a dedicated retry loop
async function ensureSocketMode(ctx: PluginContext): Promise<void> {
  const config = currentConfig ?? await loadRuntimeConfig(ctx);
  if (!config.socketModeEnabled || currentSocket || !currentCredentials?.appToken) return;
  try {
    await restartSocketMode(ctx);
    ctx.logger.info("Slack Socket Mode started on scheduled retry");
  } catch (error) {
    ctx.logger.warn("Slack Socket Mode start retry failed; will retry on next poll", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = currentConfig ?? await loadRuntimeConfig(ctx);
  const credentials = currentCredentials ?? await loadRuntimeConfig(ctx).then(() => currentCredentials);
  if (!credentials?.botToken) throw new Error("Missing Slack bot token");

  if (event.eventType === "approval.created") {
    try {
      const enriched = await approvalCreatedEventFromApi(ctx, config, event);
      await dispatchPaperclipEvent(ctx, credentials.botToken, config, enriched ?? event);
      return;
    } catch (error) {
      ctx.logger.warn("Slack approval.created enrichment failed; forwarding fallback approval notification", {
        approvalId: event.entityId,
        companyId: event.companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await dispatchPaperclipEvent(ctx, credentials.botToken, config, event);
}

async function runHumanLoopPoll(ctx: PluginContext): Promise<void> {
  const config = currentConfig ?? await loadRuntimeConfig(ctx);
  const credentials = currentCredentials ?? await loadRuntimeConfig(ctx).then(() => currentCredentials);
  if (!credentials?.botToken) throw new Error("Missing Slack bot token");
  let recordedPollFailure = false;
  try {
    const result = await pollHumanLoopAttention(ctx, credentials, config);
    // Total REST failure (every company read failed, or the companies read itself
    // threw) counts against the canary; partial failures and quiet cycles reset it.
    const totalRestFailure = result.scannedCompanies > 0 && result.failedCompanies === result.scannedCompanies;
    const sdkRpcFailure = result.failureSource === "sdk-rpc";
    if (totalRestFailure || sdkRpcFailure) {
      consecutivePollFailures += 1;
      recordedPollFailure = true;
      lastPollFailureSource = sdkRpcFailure ? "sdk-rpc" : result.failureSource ?? "rest-fetch";
      lastPollErrorKind = result.errorKind ?? "unknown";
    }
    await ctx.metrics.write("slack_human_loop_poll_completed", 1, {
      scanned_companies: String(result.scannedCompanies),
      scanned_issues: String(result.scannedIssues),
      dispatched: String(result.dispatched),
      failed_companies: String(result.failedCompanies),
    });
    if (!recordedPollFailure) {
      consecutivePollFailures = 0;
      lastPollFailureSource = "unknown";
      lastPollErrorKind = "unknown";
    }
  } catch (error) {
    const errorKind = classifyHostError(error);
    recordHostCallFailure(ctx, "job", pollFailureMethod(error), error);
    if (!recordedPollFailure) consecutivePollFailures += 1;
    lastPollFailureSource = failureSourceFor(error);
    lastPollErrorKind = errorKind;
    throw error;
  }
}

function pollFailureMethod(error: unknown): HostCallMethod {
  if (isRestFetchError(error)) {
    return error.path.includes("/issues?") ? "issues.list" : "companies.list";
  }
  return "activity.log";
}

const plugin = definePlugin({
  async setup(ctx) {
    consecutivePollFailures = 0;
    lastPollFailureSource = "unknown";
    lastPollErrorKind = "unknown";
    runtimeCtx = ctx;
    try {
      await loadRuntimeConfig(ctx);
      await restartSocketMode(ctx);
    } catch (error) {
      ctx.logger.warn("Slack Notifications config is incomplete; event handlers will retry when events arrive", { error: error instanceof Error ? error.message : String(error) });
    }

    for (const eventName of [
      "approval.created",
      "approval.decided",
      "agent.run.failed",
      "agent.run.finished",
      "issue.updated",
      "issue.relations.updated",
      "issue.assignment_wakeup_requested",
    ] as const) {
      ctx.events.on(eventName, async (event) => handleEvent(ctx, event));
    }

    ctx.jobs.register("human-loop-poll", async () => {
      await ensureSocketMode(ctx);
      await runHumanLoopPoll(ctx);
    });
  },
  async onConfigChanged(newConfig) {
    consecutivePollFailures = 0;
    lastPollFailureSource = "unknown";
    lastPollErrorKind = "unknown";
    currentConfig = normalizeConfig(newConfig);
    currentCredentials = null;
    if (runtimeCtx) {
      await loadRuntimeConfig(runtimeCtx, newConfig);
      await restartSocketMode(runtimeCtx);
    }
  },
  async onValidateConfig(config) {
    const normalized = normalizeConfig(config);
    const errors: string[] = [];
    const warnings: string[] = [];
    // Masked echoes ("***") mean a value IS stored — only reject truly empty fields,
    // otherwise saving an unrelated setting through the host UI would fail validation.
    if (!normalized.slackBotToken && !normalized.slackBotTokenRef) errors.push("Slack bot token is required.");
    if (!normalized.defaultChannelId) errors.push("Default Slack channel ID is required.");
    if (!normalized.slackAppToken && !normalized.slackAppTokenRef) warnings.push("Slack app-level token is missing; Socket Mode ingress will be disabled.");
    return { ok: errors.length === 0, errors, warnings };
  },
  async onHealth() {
    const configured = Boolean(currentConfig && currentCredentials?.botToken);
    // A dead socket with ingress enabled is a half-alive state (notifications post,
    // buttons dead) — surface it as degraded, not buried in details.
    const socketDown = Boolean(currentConfig?.socketModeEnabled && currentCredentials?.appToken && !currentSocket?.connected);
    const restDown = consecutivePollFailures >= POLL_FAILURE_HEALTH_THRESHOLD;
    const pollFailureMessage = lastPollFailureSource === "sdk-rpc"
      ? `Paperclip SDK RPC polling has failed ${consecutivePollFailures} consecutive cycles — ${pollFailureDescription(lastPollErrorKind)}; human-input detection is degraded.`
      : lastPollFailureSource === "rest-fetch"
        ? `Paperclip API polling has failed ${consecutivePollFailures} consecutive cycles — possible Paperclip REST API drift; human-input detection is down.`
        : `Paperclip polling has failed ${consecutivePollFailures} consecutive cycles — source unknown; human-input detection is degraded.`;
    return {
      status: configured && !socketDown && !restDown ? "ok" : "degraded",
      message: !configured
        ? "Slack Socket Mode worker is waiting for config."
        : socketDown
          ? "Slack Socket Mode is enabled but not connected; interactive ingress is down."
          : restDown
            ? pollFailureMessage
            : "Slack Socket Mode worker is configured.",
      details: {
        firstSlice: "Paperclip event notifications with deterministic Block Kit cards over Slack Socket Mode",
        socketModeConnected: Boolean(currentSocket?.connected),
        socketModeEnabled: Boolean(currentConfig?.socketModeEnabled),
        consecutivePollFailures,
        lastPollFailureSource,
        lastPollErrorKind,
      },
    };
  },
  async onShutdown() {
    await stopSocketMode();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

function pollFailureDescription(errorKind: HostErrorKind): string {
  switch (errorKind) {
    case "scope-denied": return "SDK RPC scope denial";
    case "capability-denied": return "SDK RPC capability denial";
    case "network": return "SDK RPC network failure";
    case "not-found": return "SDK RPC not-found response";
    case "unknown": return "SDK RPC error";
  }
}

import type { PluginContext } from "@paperclipai/plugin-sdk";

export type HostErrorKind = "scope-denied" | "capability-denied" | "not-found" | "network" | "unknown";
export type HostCallMethod = "companies.list" | "issues.list" | "issues.get" | "issues.create" | "issues.requestWakeup" | "state.get" | "state.set" | "activity.log" | "config.get" | "secrets.resolve";
export type HostCallSurface = "slash_command" | "app_mention" | "interaction" | "event_dispatch" | "poller_dispatch" | "poller" | "job";

type MetricsContext = Pick<PluginContext, "metrics" | "logger">;
type SuppressionEntry = { windowStartedAt: number; suppressed: number };

const HOST_CALL_FAILURE_SUPPRESSION_MS = 60_000;
const hostCallFailureSuppression = new Map<string, SuppressionEntry>();

export function classifyHostError(error: unknown): HostErrorKind {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const name = typeof record?.name === "string" ? record.name : "";
  const code = typeof record?.code === "string" ? record.code : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (name === "InvocationScopeDeniedError" || code === "INVOCATION_SCOPE_DENIED" || /Plugin ".+" is not allowed to perform ".+": /.test(message)) return "scope-denied";
  if (name === "CapabilityDeniedError" || code === "CAPABILITY_DENIED" || /Plugin ".+" is missing required capability ".+" for method ".+"/.test(message)) return "capability-denied";
  if (/\bHTTP 404\b/i.test(message) || /\bnot found\b/i.test(message)) return "not-found";
  if (name === "TypeError" || /\b(fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|unreachable)\b/i.test(message)) return "network";
  return "unknown";
}

export function hostErrorText(kind: HostErrorKind): string {
  switch (kind) {
    case "scope-denied": return "Paperclip temporarily rejected this plugin's request (invocation-scope restriction in core) - retry in a few minutes.";
    case "capability-denied": return "Paperclip blocked this request because the Slack plugin is missing a required gated capability.";
    case "not-found": return "Paperclip could not find the requested record.";
    case "network": return "Paperclip could not be reached from the Slack plugin.";
    case "unknown": return "Paperclip returned an unexpected error to the Slack plugin.";
  }
}

export function recordHostCallFailure(ctx: MetricsContext, surface: HostCallSurface, method: HostCallMethod, error: unknown): HostErrorKind {
  const errorKind = classifyHostError(error);
  const key = `${surface}:${method}:${errorKind}`;
  const now = Date.now();
  const existing = hostCallFailureSuppression.get(key);
  if (existing && now - existing.windowStartedAt < HOST_CALL_FAILURE_SUPPRESSION_MS) {
    existing.suppressed += 1;
    return errorKind;
  }
  const suppressed = existing?.suppressed;
  hostCallFailureSuppression.set(key, { windowStartedAt: now, suppressed: 0 });
  void ctx.metrics.write("slack_host_call_failed", 1, {
    surface,
    method,
    error_kind: errorKind,
    ...(suppressed ? { suppressed: String(suppressed) } : {}),
  }).catch((metricsError: unknown) => {
    ctx.logger.warn("Failed to write Slack host-call failure metric", { error: metricsError instanceof Error ? metricsError.message : String(metricsError) });
  });
  return errorKind;
}

export function resetHostCallFailureSuppression(): void {
  hostCallFailureSuppression.clear();
}

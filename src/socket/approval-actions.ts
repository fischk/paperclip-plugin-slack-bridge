import { ACTION_IDS, DEFAULT_PAPERCLIP_BASE_URL } from "../constants.js";
import { renderApprovalCard } from "../block-kit/approval-cards.js";
import type { NormalizedNotification, SlackNotificationsConfig } from "../types.js";
import type { SlackActionResponse, SlackActionResult, SocketContext } from "./types.js";
import { approvalPath, recordField, safeJson, simpleMessage, stringArrayField, stringField } from "./utils.js";

export async function handleApprovalAction(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  actionId: string,
  approvalId?: string,
): Promise<SlackActionResult> {
  const route = approvalActionRoute(actionId);
  const approval = parseApprovalActionValue(approvalId);
  const resolvedApprovalId = approval.approvalId;
  if (route === null || resolvedApprovalId === undefined) return null;
  const routePath = route;
  const approvalIdValue = resolvedApprovalId;
  const baseUrl = (config.paperclipBaseUrl || DEFAULT_PAPERCLIP_BASE_URL).replace(/\/$/, "");
  const approvalUrl = `${baseUrl}${approvalPath(approvalIdValue, approval.companyPrefix)}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.paperclipApiToken) headers.Authorization = `Bearer ${config.paperclipApiToken}`;
  try {
    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(approvalIdValue)}/${routePath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decisionNote: `Resolved from Slack action ${actionId}.` }),
    });
    const ok = response.status >= 200 && response.status < 300;
    const label = approvalActionLabel(actionId);
    await ctx.metrics.write("slack_approval_action_completed", 1, { actionId, ok: String(ok), status: String(response.status) });
    if (ok) {
      const body = await safeJson(response);
      const record = recordField(body) ?? { id: approvalIdValue, status: approvalStatusForRoute(routePath) };
      return approvalReplacementResponse(record, baseUrl, approvalIdValue, approval.companyPrefix, approvalUrl);
    }

    const stale = await fetchCurrentApprovalReplacement(ctx, baseUrl, headers, approvalIdValue, approval.companyPrefix, approvalUrl);
    if (stale) return stale;

    return simpleMessage(
      `${label} failed`,
      `Paperclip returned HTTP ${response.status} for approval \`${approvalIdValue}\`. Open Paperclip to finish it manually.`,
      config,
      approvalUrl,
    );
  } catch (error) {
    ctx.logger.warn("Slack approval action failed", { actionId, approvalId: approvalIdValue, error: error instanceof Error ? error.message : String(error) });
    return simpleMessage(approvalActionLabel(actionId), `I could not reach the Paperclip approval endpoint for \`${approvalIdValue}\`: ${error instanceof Error ? error.message : String(error)}`, config, approvalUrl);
  }
}

async function fetchCurrentApprovalReplacement(
  ctx: SocketContext,
  baseUrl: string,
  headers: Record<string, string>,
  approvalId: string,
  companyPrefix: string | undefined,
  approvalUrl: string,
): Promise<SlackActionResponse | null> {
  try {
    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(approvalId)}`, { headers });
    if (response.status < 200 || response.status >= 300) return null;
    const record = recordField(await safeJson(response));
    const status = stringField(record?.status);
    if (!record || !status || status === "pending") return null;
    return approvalReplacementResponse(record, baseUrl, approvalId, companyPrefix, approvalUrl);
  } catch (error) {
    ctx.logger.warn("Could not fetch current Paperclip approval after Slack approval action failed", {
      approvalId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function approvalReplacementResponse(
  record: Record<string, unknown>,
  baseUrl: string,
  fallbackApprovalId: string,
  fallbackCompanyPrefix: string | undefined,
  approvalUrl: string,
): SlackActionResponse {
  return {
    message: renderApprovalCard(approvalNotificationFromRecord(record, fallbackApprovalId, fallbackCompanyPrefix, approvalUrl), baseUrl),
    replaceOriginal: true,
    responseType: "in_channel",
  };
}

function approvalNotificationFromRecord(
  record: Record<string, unknown>,
  fallbackApprovalId: string,
  fallbackCompanyPrefix: string | undefined,
  approvalUrl: string,
): NormalizedNotification {
  const payload = recordField(record.payload) ?? {};
  const approvalId = stringField(record.id) ?? fallbackApprovalId;
  const status = stringField(record.status) ?? "approved";
  const title = stringField(payload.title)
    ?? stringField(payload.approvalTitle)
    ?? stringField(record.title)
    ?? `Approval ${approvalId}`;
  const companyPrefix = stringField(payload.companyPrefix) ?? fallbackCompanyPrefix;
  const companyName = stringField(payload.companyName);
  const approvalType = stringField(record.type) ?? stringField(payload.type) ?? stringField(payload.approvalType);
  const requestedByName = stringField(payload.requestedByName) ?? stringField(payload.requestedByAgentName);
  const summary = stringField(payload.summary) ?? stringField(payload.description);
  const recommendedAction = stringField(payload.recommendedAction);
  const risks = stringArrayField(payload.risks);
  const decisionNote = stringField(record.decisionNote);
  return {
    kind: status === "pending" ? "approval.created" : "approval.decided",
    eventId: `slack:approval:${approvalId}:${status}`,
    eventType: "approval.decided",
    occurredAt: stringField(record.updatedAt) ?? stringField(record.decidedAt) ?? new Date().toISOString(),
    companyId: stringField(record.companyId) ?? "unknown-company",
    entityId: approvalId,
    approvalId,
    title,
    approvalTitle: title,
    status,
    ...(companyPrefix ? { companyPrefix } : {}),
    ...(companyName ? { companyName } : {}),
    ...(approvalType ? { approvalType } : {}),
    ...(requestedByName ? { requestedByName } : {}),
    ...(summary ? { summary } : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(risks ? { risks } : {}),
    ...(decisionNote ? { decisionNote } : {}),
    url: approvalUrl,
    raw: {} as NormalizedNotification["raw"],
  };
}

function approvalStatusForRoute(route: "approve" | "reject" | "request-revision"): string {
  switch (route) {
    case "approve": return "approved";
    case "reject": return "rejected";
    case "request-revision": return "revision_requested";
  }
}

export function approvalActionRoute(actionId: string): "approve" | "reject" | "request-revision" | null {
  switch (actionId) {
    case ACTION_IDS.approvalApprove: return "approve";
    case ACTION_IDS.approvalDeny: return "reject";
    case ACTION_IDS.approvalRequestRevision: return "request-revision";
    default: return null;
  }
}

function approvalActionLabel(actionId: string): string {
  switch (actionId) {
    case ACTION_IDS.approvalApprove: return "Approval approved";
    case ACTION_IDS.approvalDeny: return "Approval rejected";
    case ACTION_IDS.approvalRequestRevision: return "Approval revision requested";
    default: return "Approval action";
  }
}

function parseApprovalActionValue(value?: string): { approvalId?: string; companyPrefix?: string } {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      approvalId: stringField(parsed.approvalId),
      companyPrefix: stringField(parsed.companyPrefix),
    };
  } catch {
    return { approvalId: value };
  }
}

import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { HUMAN_INPUT_EVENT_TYPE } from "./constants.js";
import { classifyHostError, recordHostCallFailure, type HostErrorKind } from "./host-errors.js";
import { dispatchPaperclipEvent } from "./notification-dispatcher.js";
import type { RuntimeSlackCredentials, SlackNotificationsConfig } from "./types.js";

const HUMAN_LOOP_REASONS = new Set(["pending_board_decision", "pending_user_decision"]);

type PollContext = Pick<PluginContext, "state" | "http" | "logger" | "activity" | "metrics">;

type ApprovalEventContext = Pick<PluginContext, "logger" | "metrics">;
export type PollFailureSource = "rest-fetch" | "sdk-rpc" | "unknown";

export class RestFetchError extends Error {
  override readonly name = "RestFetchError";
  readonly source = "rest-fetch";

  constructor(message: string, readonly path: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export async function pollHumanLoopAttention(
  ctx: PollContext,
  credentials: RuntimeSlackCredentials,
  config: SlackNotificationsConfig,
): Promise<{ scannedCompanies: number; scannedIssues: number; dispatched: number; failedCompanies: number; failureSource?: PollFailureSource; errorKind?: HostErrorKind }> {
  if (config.humanLoopPollEnabled === false) {
    return { scannedCompanies: 0, scannedIssues: 0, dispatched: 0, failedCompanies: 0 };
  }

  const companies = await listCompanies(ctx, config);
  let scannedIssues = 0;
  let failedCompanies = 0;
  let candidates = 0;
  let dispatched = 0;
  let failureSource: PollFailureSource | undefined;
  let errorKind: HostErrorKind | undefined;
  const outcomes: Record<string, number> = {};

  for (const company of companies) {
    const companyId = stringField(company.id);
    if (!companyId) continue;

    let issues: unknown[] = [];
    try {
      issues = await listCompanyIssues(ctx, config, companyId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorKind = recordHostCallFailure(ctx, "poller", "issues.list", error);
      failureSource = failureSourceFor(error);
      ctx.logger.warn("Slack human-loop poll failed to list issues", { companyId, error_kind: errorKind, failure_source: failureSource, error: message });
      failedCompanies += 1;
      continue;
    }

    scannedIssues += issues.length;
    let companyCandidates = 0;
    let agentsById: Map<string, string> | undefined;
    const companyOutcomes: Record<string, number> = {};
    for (const issue of issues) {
      const issueRecord = issue as Record<string, unknown>;
      const approvalId = pendingApprovalId(issueRecord);
      const interactionId = pendingInteractionId(issueRecord);
      let approvalDetail: Record<string, unknown> | undefined;
      let linkedIssues: Array<Record<string, unknown>> | undefined;
      let interactionDetail: Record<string, unknown> | undefined;
      if (approvalId) {
        try {
          approvalDetail = await fetchApprovalDetail(ctx, config, approvalId);
          const requestedByAgentId = stringField(approvalDetail?.requestedByAgentId);
          if (requestedByAgentId && !stringField(approvalDetail?.requestedByAgentName)) {
            agentsById ??= await listCompanyAgents(ctx, config, companyId);
            const requestedByAgentName = agentsById.get(requestedByAgentId);
            if (requestedByAgentName) approvalDetail = { ...approvalDetail, requestedByAgentName };
          }
          linkedIssues = await fetchApprovalLinkedIssues(ctx, config, approvalId);
        } catch (error) {
          const enrichKind = recordHostCallFailure(ctx, "poller", "issues.get", error);
          ctx.logger.warn("Slack human-loop poll could not enrich approval", {
            companyId,
            approvalId,
            error_kind: enrichKind,
            failure_source: failureSourceFor(error),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (interactionId) {
        try {
          interactionDetail = await fetchIssueInteraction(ctx, config, issueRecord, interactionId);
        } catch (error) {
          const enrichKind = recordHostCallFailure(ctx, "poller", "issues.get", error);
          ctx.logger.warn("Slack human-loop poll could not enrich issue-thread interaction", {
            companyId,
            interactionId,
            error_kind: enrichKind,
            failure_source: failureSourceFor(error),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const event = humanLoopEventForIssue(company, issueRecord, approvalDetail, linkedIssues, interactionDetail);
      if (!event) continue;
      candidates += 1;
      companyCandidates += 1;
      const result = await dispatchPaperclipEvent(ctx, credentials.botToken, config, event, { stateMode: "best-effort-persistent" });
      outcomes[result.reason] = (outcomes[result.reason] ?? 0) + 1;
      companyOutcomes[result.reason] = (companyOutcomes[result.reason] ?? 0) + 1;
      if (result.posted) dispatched += 1;
    }
  }

  ctx.logger.info("Slack human-loop poll completed", {
    scannedCompanies: companies.length,
    scannedIssues,
    candidates,
    dispatched,
    outcomes,
  });
  return { scannedCompanies: companies.length, scannedIssues, dispatched, failedCompanies, failureSource, errorKind };
}

export async function approvalCreatedEventFromApi(
  ctx: ApprovalEventContext,
  config: SlackNotificationsConfig,
  event: PluginEvent,
): Promise<PluginEvent | null> {
  const approvalId = stringField((event.payload as Record<string, unknown> | undefined)?.approvalId) ?? event.entityId;
  const companyId = event.companyId;
  if (!approvalId || !companyId) return null;

  const approvalDetail = await fetchApprovalDetail(ctx, config, approvalId);
  if (!approvalDetail) return null;

  let linkedIssues: Array<Record<string, unknown>> | undefined;
  try {
    linkedIssues = await fetchApprovalLinkedIssues(ctx, config, approvalId);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, "event_dispatch", "issues.get", error);
    ctx.logger.warn("Slack approval.created enrichment could not fetch linked issues", {
      companyId,
      approvalId,
      error_kind: errorKind,
      failure_source: failureSourceFor(error),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return approvalEventForDetail(companyId, approvalDetail, linkedIssues, event.occurredAt);
}

function approvalEventForDetail(
  companyId: string,
  approvalDetail: Record<string, unknown>,
  linkedIssues?: Array<Record<string, unknown>>,
  occurredAt?: string,
): PluginEvent | null {
  const approvalId = stringField(approvalDetail.id);
  if (!approvalId) return null;
  const approvalPayload = recordField(approvalDetail.payload);
  const approvalType = stringField(approvalDetail.type) ?? "request_board_approval";
  const approvalUpdatedAt = stringField(approvalDetail.updatedAt) ?? occurredAt ?? new Date(0).toISOString();
  const linkedIssueSummaries = linkedIssues?.map(issueSummary).filter(isRecord);
  const primaryIssue = linkedIssueSummaries?.[0];
  const identifier = stringField(primaryIssue?.identifier);
  const issueId = stringField(primaryIssue?.id);
  const issueTitle = stringField(primaryIssue?.title);

  return {
    eventId: approvalNotificationEventId(companyId, approvalId, approvalUpdatedAt),
    eventType: "approval.created",
    occurredAt: occurredAt ?? approvalUpdatedAt,
    actorId: "slack-notifications-approval-event",
    actorType: "plugin",
    entityId: approvalId,
    entityType: "approval",
    companyId,
    payload: {
      ...(issueId ? { issueId } : {}),
      ...(identifier ? { identifier, issueTitle } : {}),
      title: approvalPayload ? approvalLabel(approvalType, approvalPayload) : `Approval needed${identifier ? ` for ${identifier}` : ""}`,
      approvalId,
      type: approvalType,
      approvalTitle: approvalPayload ? approvalLabel(approvalType, approvalPayload) : undefined,
      summary: stringField(approvalPayload?.summary),
      recommendedAction: stringField(approvalPayload?.recommendedAction),
      risks: stringArray(approvalPayload?.risks),
      requestedByName: stringField(approvalDetail.requestedByAgentName) ?? stringField(approvalDetail.requestedByAgentId) ?? stringField(approvalDetail.requestedByUserId),
      decisionNote: stringField(approvalDetail.decisionNote),
      status: stringField(approvalDetail.status),
      linkedIssues: linkedIssueSummaries,
      issueIds: linkedIssueSummaries?.map((issue) => stringField(issue.identifier) ?? stringField(issue.id)).filter(Boolean),
      companyPrefix: identifier ? prefixFromIdentifier(identifier) : undefined,
    },
  } as unknown as PluginEvent;
}

function approvalNotificationEventId(companyId: string, approvalId: string, approvalUpdatedAt: string): string {
  return `hitl:v2:approval:${companyId}:${approvalId}:${approvalUpdatedAt}`;
}

async function listCompanies(ctx: PollContext, config: SlackNotificationsConfig): Promise<Array<Record<string, unknown>>> {
  if (config.defaultCompanyId) {
    return [{ id: config.defaultCompanyId, name: config.defaultCompanyId }];
  }
  const result = await fetchJson(ctx, config, "/api/companies");
  return Array.isArray(result) ? result.filter(isRecord) : [];
}

async function listCompanyIssues(ctx: PollContext, config: SlackNotificationsConfig, companyId: string): Promise<unknown[]> {
  const query = "attention=blocked&limit=100&includePluginOperations=true&includeBlockedInboxAttention=true&sortField=updated&sortDir=desc";
  const result = await fetchJson(ctx, config, `/api/companies/${encodeURIComponent(companyId)}/issues?${query}`);
  return Array.isArray(result) ? result : [];
}

async function listCompanyAgents(ctx: PollContext, config: SlackNotificationsConfig, companyId: string): Promise<Map<string, string>> {
  const result = await fetchJson(ctx, config, `/api/companies/${encodeURIComponent(companyId)}/agents`);
  const agents = Array.isArray(result) ? result.filter(isRecord) : [];
  return new Map(agents.map((agent) => [stringField(agent.id), stringField(agent.name)] as const).filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])));
}

async function fetchApprovalDetail(ctx: ApprovalEventContext, config: SlackNotificationsConfig, approvalId: string): Promise<Record<string, unknown> | undefined> {
  const result = await fetchJson(ctx, config, `/api/approvals/${encodeURIComponent(approvalId)}`);
  return isRecord(result) ? result : undefined;
}

async function fetchApprovalLinkedIssues(ctx: ApprovalEventContext, config: SlackNotificationsConfig, approvalId: string): Promise<Array<Record<string, unknown>> | undefined> {
  const data = await fetchJson(ctx, config, `/api/approvals/${encodeURIComponent(approvalId)}/issues`);
  return Array.isArray(data) ? data.filter(isRecord) : undefined;
}

async function fetchIssueInteraction(
  ctx: ApprovalEventContext,
  config: SlackNotificationsConfig,
  issue: Record<string, unknown>,
  interactionId: string,
): Promise<Record<string, unknown> | undefined> {
  const issueId = stringField(issue.id) ?? stringField(issue.identifier);
  if (!issueId) return undefined;
  const data = await fetchJson(ctx, config, `/api/issues/${encodeURIComponent(issueId)}/interactions`);
  if (!Array.isArray(data)) return undefined;
  return data
    .filter(isRecord)
    .find((interaction) => stringField(interaction.id) === interactionId && stringField(interaction.status) === "pending");
}

async function fetchJson(_ctx: ApprovalEventContext, config: SlackNotificationsConfig, path: string): Promise<unknown> {
  const base = (config.paperclipBaseUrl || "http://127.0.0.1:3100").replace(/\/$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.paperclipApiToken) headers.Authorization = `Bearer ${config.paperclipApiToken}`;
  // Paperclip API reads target the host Paperclip instance itself. Do not route
  // them through ctx.http.fetch: the plugin host intentionally blocks private
  // loopback/reserved IPs for generic outbound HTTP, which breaks local
  // Paperclip URLs such as http://127.0.0.1:3100.
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { headers });
  } catch (error) {
    throw new RestFetchError(error instanceof Error ? error.message : String(error), path, { cause: error });
  }
  if (!response.ok) {
    throw new RestFetchError(`HTTP ${response.status} ${response.statusText}`.trim(), path);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new RestFetchError(error instanceof Error ? error.message : String(error), path, { cause: error });
  }
}

export function isRestFetchError(error: unknown): error is RestFetchError {
  return error instanceof RestFetchError || Boolean(error && typeof error === "object" && (error as Record<string, unknown>).source === "rest-fetch");
}

export function failureSourceFor(error: unknown): PollFailureSource {
  if (isRestFetchError(error)) return "rest-fetch";
  return classifyHostError(error) === "unknown" ? "unknown" : "sdk-rpc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function humanLoopEventForIssue(
  company: Record<string, unknown>,
  issue: Record<string, unknown>,
  approvalDetail?: Record<string, unknown>,
  linkedIssues?: Array<Record<string, unknown>>,
  interactionDetail?: Record<string, unknown>,
): PluginEvent | null {
  const attention = recordField(issue.blockedInboxAttention);
  const reason = stringField(attention?.reason);
  const state = stringField(attention?.state);
  if (state !== "awaiting_decision" || !reason || !HUMAN_LOOP_REASONS.has(reason)) return null;

  const companyId = stringField(issue.companyId) ?? stringField(company.id);
  const issueId = stringField(issue.id);
  if (!companyId || !issueId) return null;

  const approvalId = stringField(attention?.approvalId);
  const interactionId = stringField(attention?.interactionId);
  if (!approvalId && !interactionId) return null;

  const identifier = stringField(issue.identifier) ?? issueId;
  const title = stringField(issue.title) ?? "Untitled issue";
  const action = recordField(attention?.action);
  const owner = recordField(attention?.owner);
  const approvalPayload = recordField(approvalDetail?.payload);
  const approvalType = stringField(approvalDetail?.type) ?? "request_board_approval";
  const approvalTitle = approvalPayload ? approvalLabel(approvalType, approvalPayload) : undefined;
  const stoppedSinceAt = stringField(attention?.stoppedSinceAt) ?? stringField(issue.updatedAt) ?? new Date(0).toISOString();
  const approvalUpdatedAt = stringField(approvalDetail?.updatedAt) ?? stoppedSinceAt;
  const linkedIssueSummaries = linkedIssues?.map(issueSummary).filter(isRecord);
  const interactionPayload = recordField(interactionDetail?.payload);
  const interactionKind = stringField(interactionDetail?.kind);
  const interactionQuestions = interactionPayload && interactionKind === "ask_user_questions" ? normalizeInteractionQuestions(interactionPayload.questions) : undefined;
  const interactionConfirmation = interactionPayload && interactionKind === "request_confirmation" ? normalizeInteractionConfirmation(interactionPayload) : undefined;
  const interactionCheckboxConfirmation = interactionPayload && interactionKind === "request_checkbox_confirmation" ? normalizeInteractionCheckboxConfirmation(interactionPayload) : undefined;
  const interactionSuggestedTasks = interactionPayload && interactionKind === "suggest_tasks" ? normalizeInteractionSuggestedTasks(interactionPayload) : undefined;
  const basePayload = {
    issueId,
    identifier,
    issueTitle: title,
    title: approvalId ? approvalTitle ?? `Approval needed for ${identifier}` : `Human input needed for ${identifier}`,
    description: stringField(action?.detail) ?? undefined,
    status: stringField(approvalDetail?.status) ?? stringField(issue.status),
    priority: stringField(issue.priority),
    assigneeName: stringField(owner?.label) ?? stringField(issue.assigneeAgentId) ?? stringField(issue.assigneeUserId),
    reason,
    actionLabel: stringField(action?.label),
    stoppedSinceAt,
    companyName: stringField(company.name),
    companyPrefix: stringField(company.issuePrefix) ?? prefixFromIdentifier(identifier),
  };

  if (approvalId) {
    return {
      eventId: approvalNotificationEventId(companyId, approvalId, approvalUpdatedAt),
      eventType: "approval.created",
      occurredAt: stoppedSinceAt,
      actorId: "slack-notifications-poll",
      actorType: "plugin",
      entityId: approvalId,
      entityType: "approval",
      companyId,
      payload: {
        ...basePayload,
        approvalId,
        type: approvalType,
        approvalTitle,
        summary: stringField(approvalPayload?.summary),
        recommendedAction: stringField(approvalPayload?.recommendedAction),
        risks: stringArray(approvalPayload?.risks),
        requestedByName: stringField(approvalDetail?.requestedByAgentName) ?? stringField(approvalDetail?.requestedByAgentId),
        decisionNote: stringField(approvalDetail?.decisionNote),
        linkedIssues: linkedIssueSummaries,
        issueIds: linkedIssueSummaries?.map((issue) => stringField(issue.identifier) ?? stringField(issue.id)).filter(Boolean),
      },
    } as unknown as PluginEvent;
  }

  return {
    eventId: `hitl:interaction:${companyId}:${interactionId}:${stoppedSinceAt}`,
    eventType: HUMAN_INPUT_EVENT_TYPE,
    occurredAt: stoppedSinceAt,
    actorId: "slack-notifications-poll",
    actorType: "plugin",
    entityId: issueId,
    entityType: "issue",
    companyId,
    payload: {
      ...basePayload,
      interactionId,
      interactionKind,
      interactionTitle: stringField(interactionDetail?.title) ?? stringField(interactionPayload?.title),
      interactionSummary: stringField(interactionDetail?.summary),
      interactionConfirmation,
      interactionCheckboxConfirmation,
      interactionSuggestedTasks,
      interactionQuestions,
    },
  } as unknown as PluginEvent;
}

function pendingApprovalId(issue: Record<string, unknown>): string | undefined {
  const attention = recordField(issue.blockedInboxAttention);
  const reason = stringField(attention?.reason);
  const state = stringField(attention?.state);
  if (state !== "awaiting_decision" || reason !== "pending_board_decision") return undefined;
  return stringField(attention?.approvalId);
}

function pendingInteractionId(issue: Record<string, unknown>): string | undefined {
  const attention = recordField(issue.blockedInboxAttention);
  const reason = stringField(attention?.reason);
  const state = stringField(attention?.state);
  if (state !== "awaiting_decision" || !reason || !HUMAN_LOOP_REASONS.has(reason)) return undefined;
  return stringField(attention?.interactionId);
}

function normalizeInteractionQuestions(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value
    .map((item) => isRecord(item) ? item : null)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((question) => {
      const options = Array.isArray(question.options)
        ? question.options
          .map((option) => isRecord(option) ? option : null)
          .filter((option): option is Record<string, unknown> => option !== null)
          .map((option) => ({ id: stringField(option.id), label: stringField(option.label) }))
          .filter((option) => option.id && option.label)
        : [];
      return {
        id: stringField(question.id),
        prompt: stringField(question.prompt),
        helpText: stringField(question.helpText),
        selectionMode: stringField(question.selectionMode),
        required: typeof question.required === "boolean" ? question.required : undefined,
        options,
      };
    })
    .filter((question) => question.id && question.prompt && question.options.length > 0);
  return questions.length ? questions : undefined;
}

function normalizeInteractionConfirmation(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const prompt = stringField(payload.prompt);
  if (!prompt) return undefined;
  return {
    prompt,
    detailsMarkdown: stringField(payload.detailsMarkdown),
    acceptLabel: stringField(payload.acceptLabel),
    rejectLabel: stringField(payload.rejectLabel),
    rejectRequiresReason: typeof payload.rejectRequiresReason === "boolean" ? payload.rejectRequiresReason : undefined,
  };
}

function normalizeInteractionCheckboxConfirmation(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const base = normalizeInteractionConfirmation(payload);
  if (!base) return undefined;
  const options = Array.isArray(payload.options)
    ? payload.options
      .map((option) => isRecord(option) ? option : null)
      .filter((option): option is Record<string, unknown> => option !== null)
      .map((option) => ({ id: stringField(option.id), label: stringField(option.label) }))
      .filter((option) => option.id && option.label)
    : [];
  if (options.length === 0) return undefined;
  return {
    ...base,
    options,
    defaultSelectedOptionIds: stringArray(payload.defaultSelectedOptionIds),
    minSelected: typeof payload.minSelected === "number" && Number.isFinite(payload.minSelected) ? payload.minSelected : undefined,
    maxSelected: payload.maxSelected === null ? null : typeof payload.maxSelected === "number" && Number.isFinite(payload.maxSelected) ? payload.maxSelected : undefined,
  };
}

function normalizeInteractionSuggestedTasks(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const tasks = Array.isArray(payload.tasks)
    ? payload.tasks
      .map((task) => isRecord(task) ? task : null)
      .filter((task): task is Record<string, unknown> => task !== null)
      .map((task) => ({
        clientKey: stringField(task.clientKey),
        title: stringField(task.title),
        description: stringField(task.description),
        priority: stringField(task.priority),
        workMode: stringField(task.workMode),
        parentClientKey: stringField(task.parentClientKey),
        hiddenInPreview: typeof task.hiddenInPreview === "boolean" ? task.hiddenInPreview : undefined,
      }))
      .filter((task) => task.clientKey && task.title)
    : [];
  if (tasks.length === 0) return undefined;
  return {
    tasks,
    defaultParentId: stringField(payload.defaultParentId),
  };
}

function approvalLabel(type: string, payload: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    hire_agent: "Hire Agent",
    approve_ceo_strategy: "CEO Strategy",
    budget_override_required: "Budget Override",
    request_board_approval: "Board Approval",
  };
  const subject = firstNonEmptyString(payload.title, payload.name, payload.summary, payload.recommendedAction);
  return subject ? `${labels[type] ?? type}: ${subject}` : labels[type] ?? type;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringField(value);
    if (text) return text;
  }
  return undefined;
}

function issueSummary(issue: Record<string, unknown>): Record<string, unknown> {
  return {
    id: stringField(issue.id),
    identifier: stringField(issue.identifier),
    title: stringField(issue.title),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringField(item)).filter((item): item is string => Boolean(item));
}

function prefixFromIdentifier(identifier: string): string | undefined {
  const match = identifier.match(/^([A-Za-z][A-Za-z0-9]*)[-_]/);
  return match?.[1]?.toUpperCase();
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

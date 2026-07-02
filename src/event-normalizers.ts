import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { DEFAULT_PAPERCLIP_BASE_URL, HUMAN_INPUT_EVENT_TYPE } from "./constants.js";
import type { InteractionCheckboxConfirmation, InteractionConfirmation, InteractionQuestion, InteractionSuggestedTasks, NormalizedNotification, SuggestedTaskDraft } from "./types.js";

function payloadOf(event: PluginEvent): Record<string, unknown> {
  return (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function issueSummaries(value: unknown): Array<{ id?: string; identifier?: string; title?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value
    .map((item) => (item && typeof item === "object" ? item as Record<string, unknown> : null))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      id: str(item.id),
      identifier: str(item.identifier),
      title: str(item.title),
    }))
    .filter((item) => item.id || item.identifier || item.title);
  return issues.length ? issues : undefined;
}

function interactionQuestions(value: unknown): InteractionQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value
    .map((item) => (item && typeof item === "object" ? item as Record<string, unknown> : null))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const id = str(item.id);
      const prompt = str(item.prompt);
      const mode = str(item.selectionMode);
      const options = Array.isArray(item.options)
        ? item.options
          .map((option) => (option && typeof option === "object" ? option as Record<string, unknown> : null))
          .filter((option): option is Record<string, unknown> => option !== null)
          .map((option) => ({ id: str(option.id), label: str(option.label) }))
          .filter((option): option is { id: string; label: string } => Boolean(option.id && option.label))
        : [];
      if (!id || !prompt || (mode !== "single" && mode !== "multi") || options.length === 0) return null;
      const question: InteractionQuestion = {
        id,
        prompt,
        ...(str(item.helpText) ? { helpText: str(item.helpText) } : {}),
        selectionMode: mode,
        ...(typeof item.required === "boolean" ? { required: item.required } : {}),
        options,
      };
      return question;
    })
    .filter((item): item is InteractionQuestion => item !== null);
  return questions.length ? questions : undefined;
}

function interactionConfirmation(value: unknown): InteractionConfirmation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const prompt = str(item.prompt);
  if (!prompt) return undefined;
  const confirmation: InteractionConfirmation = { prompt };
  const detailsMarkdown = str(item.detailsMarkdown);
  const acceptLabel = str(item.acceptLabel);
  const rejectLabel = str(item.rejectLabel);
  if (detailsMarkdown) confirmation.detailsMarkdown = detailsMarkdown;
  if (acceptLabel) confirmation.acceptLabel = acceptLabel;
  if (rejectLabel) confirmation.rejectLabel = rejectLabel;
  if (typeof item.rejectRequiresReason === "boolean") confirmation.rejectRequiresReason = item.rejectRequiresReason;
  return confirmation;
}

function interactionCheckboxConfirmation(value: unknown): InteractionCheckboxConfirmation | undefined {
  const base = interactionConfirmation(value);
  if (!base || !value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const options = Array.isArray(item.options)
    ? item.options
      .map((option) => (option && typeof option === "object" ? option as Record<string, unknown> : null))
      .filter((option): option is Record<string, unknown> => option !== null)
      .map((option) => ({ id: str(option.id), label: str(option.label) }))
      .filter((option): option is { id: string; label: string } => Boolean(option.id && option.label))
    : [];
  if (options.length === 0) return undefined;
  const defaultSelectedOptionIds = stringArray(item.defaultSelectedOptionIds);
  const minSelected = finiteNumber(item.minSelected);
  const maxSelected = item.maxSelected === null ? null : finiteNumber(item.maxSelected);
  return {
    ...base,
    options,
    ...(defaultSelectedOptionIds.length > 0 ? { defaultSelectedOptionIds } : {}),
    ...(minSelected !== undefined ? { minSelected } : {}),
    ...(maxSelected !== undefined ? { maxSelected } : {}),
  };
}

function interactionSuggestedTasks(value: unknown): InteractionSuggestedTasks | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tasks = Array.isArray(item.tasks)
    ? item.tasks
      .map((task) => (task && typeof task === "object" ? task as Record<string, unknown> : null))
      .filter((task): task is Record<string, unknown> => task !== null)
      .map((task): SuggestedTaskDraft | null => {
        const clientKey = str(task.clientKey);
        const title = str(task.title);
        if (!clientKey || !title) return null;
        return {
          clientKey,
          title,
          ...(str(task.description) ? { description: str(task.description) } : {}),
          ...(str(task.priority) ? { priority: str(task.priority) } : {}),
          ...(str(task.workMode) ? { workMode: str(task.workMode) } : {}),
          ...(str(task.parentClientKey) ? { parentClientKey: str(task.parentClientKey) } : {}),
          ...(typeof task.hiddenInPreview === "boolean" ? { hiddenInPreview: task.hiddenInPreview } : {}),
        };
      })
      .filter((task): task is SuggestedTaskDraft => task !== null)
    : [];
  if (tasks.length === 0) return undefined;
  return {
    tasks,
    ...(str(item.defaultParentId) ? { defaultParentId: str(item.defaultParentId) } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function base(event: PluginEvent, kind: NormalizedNotification["kind"], title: string): NormalizedNotification {
  const payload = payloadOf(event);
  return {
    kind,
    eventId: event.eventId || `${event.eventType}:${event.entityId ?? "unknown"}:${event.occurredAt}`,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    companyId: event.companyId,
    entityId: event.entityId,
    issueId: str(payload.issueId) ?? (event.entityType === "issue" ? event.entityId : undefined),
    runId: str(payload.runId) ?? (event.entityType === "run" ? event.entityId : undefined),
    approvalId: str(payload.approvalId) ?? (event.entityType === "approval" ? event.entityId : undefined),
    projectId: str(payload.projectId),
    agentId: str(payload.agentId),
    identifier: str(payload.identifier) ?? str(payload.issueIdentifier) ?? str(event.entityId),
    title,
    description: str(payload.description) ?? str(payload.summary),
    status: str(payload.status),
    previousStatus: str(payload.previousStatus) ?? str(payload.oldStatus),
    priority: str(payload.priority),
    companyName: str(payload.companyName),
    companyPrefix: str(payload.companyPrefix) ?? prefixFromIdentifier(str(payload.identifier) ?? str(payload.issueIdentifier)),
    projectName: str(payload.projectName),
    agentName: str(payload.agentName) ?? str(payload.name),
    assigneeName: str(payload.assigneeName) ?? str(payload.assigneeAgentName),
    blockerIds: stringArray(payload.blockerIds ?? payload.blockedByIssueIds),
    issueIds: stringArray(payload.issueIds),
    interactionId: str(payload.interactionId),
    interactionKind: str(payload.interactionKind),
    interactionTitle: str(payload.interactionTitle),
    interactionSummary: str(payload.interactionSummary),
    interactionConfirmation: interactionConfirmation(payload.interactionConfirmation),
    interactionCheckboxConfirmation: interactionCheckboxConfirmation(payload.interactionCheckboxConfirmation),
    interactionSuggestedTasks: interactionSuggestedTasks(payload.interactionSuggestedTasks),
    interactionQuestions: interactionQuestions(payload.interactionQuestions),
    attentionReason: str(payload.reason) ?? str(payload.attentionReason),
    actionLabel: str(payload.actionLabel),
    approvalType: str(payload.type) ?? str(payload.approvalType),
    approvalTitle: str(payload.approvalTitle),
    recommendedAction: str(payload.recommendedAction),
    risks: stringArray(payload.risks),
    requestedByName: str(payload.requestedByName) ?? str(payload.requestedByAgentName),
    decisionNote: str(payload.decisionNote),
    linkedIssues: issueSummaries(payload.linkedIssues),
    error: str(payload.error) ?? str(payload.message),
    summary: str(payload.resultSummary) ?? str(payload.summary),
    raw: event,
  };
}

export function normalizeEvent(event: PluginEvent, paperclipBaseUrl = DEFAULT_PAPERCLIP_BASE_URL): NormalizedNotification | null {
  const payload = payloadOf(event);
  switch (event.eventType) {
    case "approval.created": {
      const approvalId = str(payload.approvalId) ?? event.entityId;
      const title = str(payload.title) ?? str(payload.issueTitle) ?? "Approval requested";
      const companyPrefix = str(payload.companyPrefix) ?? prefixFromIdentifier(str(payload.identifier) ?? str(payload.issueIdentifier));
      const path = approvalId ? approvalPath(approvalId, companyPrefix) : undefined;
      return withUrl(base(event, "approval.created", title), paperclipBaseUrl, path);
    }
    case HUMAN_INPUT_EVENT_TYPE: {
      const issueId = str(payload.issueId) ?? event.entityId;
      const title = str(payload.title) ?? str(payload.issueTitle) ?? "Human input needed";
      return withUrl(base(event, "human.input_needed", title), paperclipBaseUrl, issueId ? `/issues/${issueId}` : undefined);
    }
    case "agent.run.failed": {
      const title = str(payload.title) ?? str(payload.agentName) ?? "Agent run failed";
      const runId = str(payload.runId) ?? event.entityId;
      return withUrl(base(event, "run.failed", title), paperclipBaseUrl, runId ? `/runs/${runId}` : undefined);
    }
    case "agent.run.finished": {
      const title = str(payload.title) ?? str(payload.agentName) ?? "Agent run finished";
      const runId = str(payload.runId) ?? event.entityId;
      return withUrl(base(event, "run.finished", title), paperclipBaseUrl, runId ? `/runs/${runId}` : undefined);
    }
    case "issue.assignment_wakeup_requested": {
      const title = str(payload.title) ?? str(payload.issueTitle) ?? "Issue assigned / wakeup requested";
      const issueId = str(payload.issueId) ?? event.entityId;
      return withUrl(base(event, "issue.assigned", title), paperclipBaseUrl, issueId ? `/issues/${issueId}` : undefined);
    }
    case "issue.relations.updated": {
      const blockerIds = stringArray(payload.blockerIds ?? payload.blockedByIssueIds);
      const previousBlockerIds = stringArray(payload.previousBlockerIds ?? payload.previousBlockedByIssueIds);
      const kind = blockerIds.length > 0 || previousBlockerIds.length === 0 ? "issue.blocked" : "issue.unblocked";
      const title = str(payload.title) ?? str(payload.issueTitle) ?? (kind === "issue.blocked" ? "Issue blocked" : "Issue unblocked");
      const issueId = str(payload.issueId) ?? event.entityId;
      return withUrl(base(event, kind, title), paperclipBaseUrl, issueId ? `/issues/${issueId}` : undefined);
    }
    case "issue.updated": {
      const status = str(payload.status);
      const previousStatus = str(payload.previousStatus) ?? str(payload.oldStatus);
      if (status === "done" || status === "completed") {
        const title = str(payload.title) ?? str(payload.issueTitle) ?? "Issue completed";
        const issueId = str(payload.issueId) ?? event.entityId;
        return withUrl(base(event, "issue.completed", title), paperclipBaseUrl, issueId ? `/issues/${issueId}` : undefined);
      }
      if ((str(payload.assigneeAgentId) || str(payload.assigneeName) || str(payload.assigneeAgentName)) && previousStatus !== status) {
        const title = str(payload.title) ?? str(payload.issueTitle) ?? "Issue assigned";
        const issueId = str(payload.issueId) ?? event.entityId;
        return withUrl(base(event, "issue.assigned", title), paperclipBaseUrl, issueId ? `/issues/${issueId}` : undefined);
      }
      return null;
    }
    default:
      return null;
  }
}

function withUrl(notification: NormalizedNotification, baseUrl: string, path?: string): NormalizedNotification {
  if (!path) return notification;
  return { ...notification, url: `${baseUrl.replace(/\/$/, "")}${path}` };
}

function prefixFromIdentifier(identifier?: string): string | undefined {
  const match = identifier?.match(/^([A-Za-z][A-Za-z0-9]*)[-_]/);
  return match?.[1]?.toUpperCase();
}

function approvalPath(approvalId: string, companyPrefix?: string): string {
  return companyPrefix ? `/${companyPrefix}/approvals/${approvalId}` : `/approvals/${approvalId}`;
}

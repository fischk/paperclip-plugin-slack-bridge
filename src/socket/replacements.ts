import { ACTION_IDS } from "../constants.js";
import type { SlackMessage } from "../types.js";
import type { IssueInteractionRef, SlackActionResponse, SocketContext } from "./types.js";
import { recordField, stringArrayField, stringField } from "./utils.js";

export async function fetchCurrentInteractionRecord(
  ctx: SocketContext,
  baseUrl: string,
  headers: Record<string, string>,
  interaction: IssueInteractionRef,
  reason: string,
): Promise<Record<string, unknown> | undefined> {
  if (!interaction.issueId || !interaction.interactionId) return undefined;
  try {
    const response = await fetch(`${baseUrl}/api/issues/${encodeURIComponent(interaction.issueId)}/interactions`, { headers });
    if (response.status < 200 || response.status >= 300) return undefined;
    const interactions = await response.json() as unknown;
    if (!Array.isArray(interactions)) return undefined;
    return recordField(interactions.find((item) => recordField(item)?.id === interaction.interactionId));
  } catch (error) {
    ctx.logger.warn("Could not fetch current Paperclip interaction", {
      issueId: interaction.issueId,
      interactionId: interaction.interactionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function replaceOriginalResponse(message: SlackMessage): SlackActionResponse {
  return { message, replaceOriginal: true, responseType: "in_channel" };
}

export async function fetchCurrentConfirmationReplacement(
  ctx: SocketContext,
  baseUrl: string,
  headers: Record<string, string>,
  interaction: IssueInteractionRef,
  issueUrl: string,
): Promise<SlackActionResponse | null> {
  const record = await fetchCurrentInteractionRecord(ctx, baseUrl, headers, interaction, "Slack confirmation action");
  const status = stringField(record?.status);
  if (!record || !status || status === "pending") return null;
  return interactionConfirmationReplacement(record, status, issueUrl);
}

export function interactionConfirmationReplacement(
  record: Record<string, unknown> | undefined,
  fallbackStatus: string,
  issueUrl: string,
): SlackActionResponse {
  const kind = stringField(record?.kind);
  if (kind === "suggest_tasks") return interactionSuggestedTasksReplacement(record, fallbackStatus, issueUrl);
  const status = stringField(record?.status) ?? fallbackStatus;
  const title = stringField(record?.title) ?? confirmationStatusTitle(status);
  const result = recordField(record?.result);
  const reason = stringField(result?.reason);
  const outcome = stringField(result?.outcome);
  const details = reason
    ? `Reason: ${reason}`
    : outcome && outcome !== status
      ? `Outcome: ${outcome}`
      : confirmationStatusBody(status);
  return replaceOriginalResponse(interactionResolvedMessage(title, confirmationStatusTitle(status), details, issueUrl));
}

export function interactionSuggestedTasksReplacement(
  record: Record<string, unknown> | undefined,
  fallbackStatus: string,
  issueUrl: string,
): SlackActionResponse {
  const status = stringField(record?.status) ?? fallbackStatus;
  const title = stringField(record?.title) ?? "Suggested tasks";
  const result = recordField(record?.result);
  const createdTasks = arrayField(result?.createdTasks)
    .map((item) => recordField(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const skippedClientKeys = stringArrayField(result?.skippedClientKeys) ?? [];
  const rejectionReason = stringField(result?.rejectionReason);
  const detail = status === "accepted"
    ? suggestedTasksAcceptedDetail(createdTasks, skippedClientKeys)
    : rejectionReason
      ? `Reason: ${rejectionReason}`
      : status === "rejected"
        ? "Rejected from Slack and recorded in Paperclip."
        : `Paperclip has recorded the current suggested-tasks state: ${status}.`;
  const statusTitle = status === "accepted" ? "Suggested tasks created" : status === "rejected" ? "Suggested tasks rejected" : `Suggested tasks ${status}`;
  return replaceOriginalResponse(interactionResolvedMessage(title, statusTitle, detail, issueUrl));
}

function suggestedTasksAcceptedDetail(createdTasks: Record<string, unknown>[], skippedClientKeys: string[]): string {
  const created = createdTasks.map((task) => {
    const identifier = stringField(task.identifier);
    const title = stringField(task.title) ?? stringField(task.clientKey) ?? "created task";
    return `- ${identifier ? `${identifier}: ` : ""}${title}`;
  });
  const skipped = skippedClientKeys.length > 0 ? `\nSkipped: ${skippedClientKeys.join(", ")}` : "";
  return created.length > 0 ? `Created ${created.length} task${created.length === 1 ? "" : "s"}:\n${created.join("\n")}${skipped}` : `No task details were returned by Paperclip.${skipped}`;
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function confirmationStatusTitle(status: string): string {
  switch (status) {
    case "accepted": return "Confirmation accepted";
    case "rejected": return "Confirmation rejected";
    case "expired": return "Confirmation expired";
    default: return `Confirmation ${status}`;
  }
}

function confirmationStatusBody(status: string): string {
  switch (status) {
    case "accepted": return "Accepted from Slack and recorded in Paperclip.";
    case "rejected": return "Rejected from Slack and recorded in Paperclip.";
    case "expired": return "This confirmation is no longer current in Paperclip.";
    default: return "Paperclip has recorded the current confirmation state.";
  }
}

export function interactionResolvedMessage(title: string, statusTitle: string, detail: string, issueUrl: string): SlackMessage {
  return {
    text: `${title}: ${statusTitle}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${title}*\n:white_check_mark: ${statusTitle}.` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: detail },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Paperclip • human.input_needed • resolved" }],
      },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Open Issue", emoji: true }, url: issueUrl, action_id: ACTION_IDS.issueOpen }],
      },
    ],
  };
}

export async function fetchResolvedInteractionMessage(
  ctx: SocketContext,
  baseUrl: string,
  headers: Record<string, string>,
  submit: IssueInteractionRef,
  issueUrl: string,
): Promise<SlackActionResponse | null> {
  const record = await fetchCurrentInteractionRecord(ctx, baseUrl, headers, submit, "Slack duplicate question submit");
  if (!record || stringField(record.status) !== "answered") return null;
  const result = recordField(record.result);
  const summaryMarkdown = stringField(result?.summaryMarkdown) ?? "This question has already been answered in Paperclip.";
  const title = stringField(record.title) ?? "Question answered";
  return replaceOriginalResponse(interactionAnsweredMessage(title, summaryMarkdown, issueUrl));
}

export function interactionAnsweredMessage(title: string, summaryMarkdown: string, issueUrl: string): SlackMessage {
  const cleanSummary = summaryMarkdown.trim() || "Answered in Paperclip.";
  return {
    text: `${title}: answered`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${title}*\n:white_check_mark: Answer recorded in Paperclip.` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Submitted summary*\n${cleanSummary}` },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Paperclip • human.input_needed • answered" }],
      },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Open Issue", emoji: true }, url: issueUrl, action_id: ACTION_IDS.issueOpen }],
      },
    ],
  };
}

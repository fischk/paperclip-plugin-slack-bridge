import { ACTION_IDS } from "../constants.js";
import type { SlackBlock, SlackMessage } from "../types.js";
import type { InteractionActionValue, IssueInteractionRef, SlackActionResponse, SocketContext } from "./types.js";
import { numberField, recordField, stringArrayField, stringField } from "./utils.js";

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

function oversizedCheckboxConfirmationMessage(identifier: string, issueUrl: string): SlackMessage {
  const text = `${identifier} _This confirmation has more options than Slack can show inline. <${issueUrl}|Open the issue to choose them.>_`;
  return { text: `${identifier}: open in Paperclip`, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

function interactionActionValue(interaction: InteractionActionValue, options: { includeCheckboxDefaults?: boolean } = {}): string {
  const includeCheckboxDefaults = options.includeCheckboxDefaults !== false;
  return JSON.stringify({
    issueId: interaction.issueId,
    interactionId: interaction.interactionId,
    companyPrefix: interaction.companyPrefix,
    kind: interaction.kind,
    optionActionId: interaction.optionActionId,
    rejectRequiresReason: interaction.rejectRequiresReason === true,
    title: interaction.title ? truncateSlackText(interaction.title, 180) : undefined,
    identifier: interaction.identifier ? truncateSlackText(interaction.identifier, 80) : undefined,
    prompt: interaction.prompt ? truncateSlackText(interaction.prompt, 360) : undefined,
    summary: interaction.summary ? truncateSlackText(interaction.summary, 160) : undefined,
    detailsMarkdown: interaction.detailsMarkdown ? truncateSlackText(interaction.detailsMarkdown, 320) : undefined,
    acceptLabel: interaction.acceptLabel ? truncateSlackText(interaction.acceptLabel, 75) : undefined,
    rejectLabel: interaction.rejectLabel ? truncateSlackText(interaction.rejectLabel, 75) : undefined,
    minSelected: interaction.minSelected,
    maxSelected: interaction.maxSelected,
    taskClientKeys: interaction.taskClientKeys,
    taskParentClientKeys: interaction.taskParentClientKeys,
    ...(includeCheckboxDefaults && interaction.defaultSelectedOptionIds ? {
      defaultSelectedOptionIds: interaction.defaultSelectedOptionIds.slice(0, 10).map((id) => truncateSlackText(id, 120)),
    } : {}),
  });
}

export function interactionConfirmationPendingMessage(interaction: InteractionActionValue, issueUrl: string): SlackMessage {
  const title = interaction.title ?? interaction.identifier ?? "Confirmation requested";
  const prompt = interaction.prompt ?? "Review the confirmation in Paperclip.";
  const details = confirmationDetails(interaction);
  const value = interactionActionValue(interaction);
  return {
    text: `${title}: confirmation requested`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${title}*\n*Confirmation requested*\n${prompt}${details}` },
      },
      {
        type: "actions",
        elements: [
          slackButton(interaction.acceptLabel ?? "Accept", ACTION_IDS.interactionAccept, value, "primary"),
          slackButton(interaction.rejectLabel ?? "Reject", ACTION_IDS.interactionRejectStart, value, "danger"),
        ],
      },
      openIssueActions(issueUrl),
      { type: "context", elements: [{ type: "mrkdwn", text: "Paperclip • human.input_needed • pending" }] },
    ],
  };
}

export function interactionCheckboxConfirmationPendingMessage(
  record: Record<string, unknown> | undefined,
  fallback: InteractionActionValue,
  issueUrl: string,
): SlackMessage {
  const payload = recordField(record?.payload);
  const allOptions = arrayField(payload?.options)
    .map((item) => recordField(item))
    .map((item) => ({ id: stringField(item?.id), label: stringField(item?.label) }))
    .filter((item): item is { id: string; label: string } => Boolean(item.id && item.label));
  if (allOptions.length === 0) return interactionConfirmationPendingMessage(fallback, issueUrl);
  const supportsInlineAccept = allOptions.length <= 10;
  const options = allOptions.slice(0, 10);

  const title = stringField(record?.title) ?? fallback.title ?? fallback.identifier ?? "Checkbox confirmation requested";
  if (!supportsInlineAccept) return oversizedCheckboxConfirmationMessage(fallback.identifier ?? fallback.issueId ?? title, issueUrl);
  const prompt = stringField(payload?.prompt) ?? fallback.prompt ?? "Review the confirmation in Paperclip.";
  const summary = stringField(record?.summary) ?? fallback.summary;
  const detailsMarkdown = stringField(payload?.detailsMarkdown) ?? fallback.detailsMarkdown;
  const minSelected = numberField(payload?.minSelected) ?? fallback.minSelected ?? 0;
  const maxSelected = payload?.maxSelected === null ? null : numberField(payload?.maxSelected) ?? fallback.maxSelected ?? null;
  const defaultSelectedOptionIds = stringArrayField(payload?.defaultSelectedOptionIds) ?? fallback.defaultSelectedOptionIds;
  const actionValue: InteractionActionValue = {
    issueId: fallback.issueId,
    interactionId: fallback.interactionId,
    companyPrefix: fallback.companyPrefix,
    kind: "request_checkbox_confirmation",
    optionActionId: ACTION_IDS.interactionCheckboxSelect,
    rejectRequiresReason: true,
    title,
    identifier: fallback.identifier,
    prompt,
    ...(summary ? { summary } : {}),
    ...(detailsMarkdown ? { detailsMarkdown } : {}),
    acceptLabel: stringField(payload?.acceptLabel) ?? fallback.acceptLabel,
    rejectLabel: stringField(payload?.rejectLabel) ?? fallback.rejectLabel,
    minSelected,
    maxSelected,
    taskClientKeys: [],
    taskParentClientKeys: {},
    defaultSelectedOptionIds: supportsInlineAccept ? defaultSelectedOptionIds : [],
  };
  const value = interactionActionValue(actionValue, { includeCheckboxDefaults: supportsInlineAccept });
  const details = confirmationDetails(actionValue);
  const bodyBlocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*\n*Checkbox confirmation requested*\n${prompt}${details}\n_${checkboxBoundsLabel(minSelected, maxSelected)}_` },
    },
    ...(supportsInlineAccept
      ? [checkboxInputBlock(options, defaultSelectedOptionIds, minSelected === 0)]
      : [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `_This confirmation has more options than Slack can show inline. <${issueUrl}|Open the issue to choose them.>_` } }]),
  ];
  return {
    text: `${title}: checkbox confirmation requested`,
    blocks: [
      ...bodyBlocks,
      ...(supportsInlineAccept ? [{
        type: "actions" as const,
        elements: [
          slackButton(actionValue.acceptLabel ?? "Accept", ACTION_IDS.interactionAccept, value, "primary"),
          slackButton(actionValue.rejectLabel ?? "Reject", ACTION_IDS.interactionRejectStart, value, "danger"),
        ],
      }, openIssueActions(issueUrl)] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: "Paperclip • human.input_needed • pending" }] },
    ],
  };
}

export function interactionConfirmationDeclineMessage(interaction: InteractionActionValue, issueUrl: string): SlackMessage {
  const title = interaction.title ?? interaction.identifier ?? "Confirmation requested";
  const prompt = interaction.prompt ?? "Review the confirmation in Paperclip.";
  const details = confirmationDetails(interaction);
  const value = interactionActionValue(interaction);
  return {
    text: `${title}: decline notes needed`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${title}*\n*Send back with notes*\n${prompt}${details}` },
      },
      {
        type: "input",
        block_id: interactionRejectReasonBlockId(),
        label: { type: "plain_text", text: "Decline notes", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: ACTION_IDS.interactionRejectReason,
          multiline: true,
          max_length: 3000,
          placeholder: { type: "plain_text", text: "Tell the agent what you want changed.", emoji: true },
        },
        optional: false,
      },
      {
        type: "actions",
        elements: [
          slackButton(interaction.rejectLabel ?? "Send back", ACTION_IDS.interactionReject, value, "danger"),
          slackButton("Cancel", ACTION_IDS.interactionRejectCancel, value),
        ],
      },
      openIssueActions(issueUrl),
      { type: "context", elements: [{ type: "mrkdwn", text: "Paperclip • human.input_needed • send-back notes" }] },
    ],
  };
}

function confirmationDetails(interaction: InteractionActionValue): string {
  const summary = interaction.summary ? `\n_${interaction.summary}_` : "";
  const details = interaction.detailsMarkdown ? `\n>${interaction.detailsMarkdown.replace(/\n/g, "\n>")}` : "";
  return `${summary}${details}`;
}

function interactionRejectReasonBlockId(): string {
  return "pc_interaction_reject_reason";
}

function checkboxInputBlock(options: Array<{ id: string; label: string }>, selectedOptionIds: string[], optional: boolean): SlackBlock {
  const renderedOptions = options.map((option) => ({
    text: { type: "plain_text", text: truncateSlackText(option.label, 75), emoji: true },
    value: truncateSlackText(option.id, 120),
  }));
  const selected = new Set(selectedOptionIds);
  const initialOptions = renderedOptions.filter((option) => selected.has(String(option.value)));
  return {
    type: "input",
    block_id: "pc_interaction_checkbox_confirmation",
    label: { type: "plain_text", text: "Options", emoji: true },
    element: {
      type: "checkboxes",
      action_id: ACTION_IDS.interactionCheckboxSelect,
      options: renderedOptions,
      ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
    },
    optional,
  };
}

function checkboxBoundsLabel(minSelected: number, maxSelected: number | null): string {
  if (maxSelected !== null) return `Select ${minSelected === maxSelected ? minSelected : `${minSelected}–${maxSelected}`} option${maxSelected === 1 ? "" : "s"}.`;
  if (minSelected > 0) return `Select at least ${minSelected} option${minSelected === 1 ? "" : "s"}.`;
  return "Select any options that apply.";
}

function slackButton(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

function openIssueActions(issueUrl: string) {
  return {
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: "Open Issue", emoji: true }, url: issueUrl, action_id: ACTION_IDS.issueOpen }],
  };
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
  return replaceOriginalResponse(interactionConfirmationResolvedMessage(title, status, issueUrl));
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

export function interactionConfirmationResolvedMessage(title: string, status: string, issueUrl: string): SlackMessage {
  const label = confirmationReceiptLabel(status);
  return {
    text: `${label}: ${title}`,
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `${label} · <${issueUrl}|View in Paperclip>\n${truncateSlackText(title, 220)}` },
    }],
  };
}

function confirmationReceiptLabel(status: string): string {
  switch (status) {
    case "accepted": return "✅ Approved";
    case "rejected": return "↩️ Sent back";
    case "expired": return "⌛ Expired";
    default: return `ℹ️ Confirmation ${status.replace(/_/g, " ")}`;
  }
}

function truncateSlackText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
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

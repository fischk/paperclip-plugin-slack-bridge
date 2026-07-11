import { ACTION_IDS } from "../constants.js";
import type { NormalizedNotification, SlackMessage, SuggestedTaskDraft } from "../types.js";
import { actionBlock, button, checkboxes, contextFooter, fieldsBlock, inputBlock, linkButton, paperclipUrl, plainTextInput, radioButtons, section } from "./common.js";
import { assertSlackMessageBounds, truncateText } from "./limits.js";

export function renderIssueCard(notification: NormalizedNotification, baseUrl: string): SlackMessage {
  const issueId = notification.issueId ?? notification.entityId ?? notification.eventId;
  const url = notification.url ?? paperclipUrl(baseUrl, `/issues/${issueId}`);
  const enrichedQuestion = isEnrichedQuestionNotification(notification);
  const enrichedConfirmation = isEnrichedConfirmationNotification(notification);
  const enrichedCheckboxConfirmation = isEnrichedCheckboxConfirmationNotification(notification);
  const enrichedSuggestedTasks = isEnrichedSuggestedTasksNotification(notification);
  const enrichedInteraction = enrichedQuestion || enrichedConfirmation || enrichedCheckboxConfirmation || enrichedSuggestedTasks;
  const heading = issueHeading(notification);
  const body = !enrichedInteraction && notification.description ? `\n>${truncateText(notification.description, 900)}` : "";
  const interactionBlocks = enrichedSuggestedTasks
    ? renderInteractionSuggestedTasks(notification)
    : enrichedCheckboxConfirmation
    ? renderInteractionCheckboxConfirmation(notification)
    : enrichedConfirmation
      ? renderInteractionConfirmation(notification)
      : renderInteractionQuestions(notification);
  const answerButtons = enrichedSuggestedTasks
    ? renderSuggestedTaskButtons(notification)
    : enrichedConfirmation || enrichedCheckboxConfirmation ? renderConfirmationButtons(notification) : renderAnswerButtons(notification);
  const fields = fieldsBlock([
    ["Issue", notification.identifier ?? issueId],
    ["Status", notification.status],
    ["Assignee", notification.assigneeName ?? notification.agentName],
    ["Project", notification.projectName],
    ["Priority", notification.priority],
    ["Blockers", notification.blockerIds?.join(", ")],
    ...(!enrichedInteraction ? [
      ["Interaction", notification.interactionId],
      ["Action", notification.actionLabel],
    ] as Array<[string, string | undefined]> : []),
  ]);
  const title = enrichedInteraction ? (notification.identifier ?? notification.title.replace(/^Human input needed for\s+/i, "")) : notification.title;
  const topSection = enrichedInteraction ? heading : `${heading}\n*${truncateText(title, 220)}*${body}`;
  const blocks = [
    section(topSection),
    ...interactionBlocks,
    ...(fields ? [fields] : []),
    ...(answerButtons.length > 0 ? [actionBlock(answerButtons)] : []),
    actionBlock([linkButton("Open Issue", url, ACTION_IDS.issueOpen)]),
    contextFooter(notification),
  ];
  const message = { text: `${plainKind(notification)}: ${title}`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

function renderInteractionConfirmation(notification: NormalizedNotification) {
  const confirmation = notification.interactionConfirmation;
  if (notification.kind !== "human.input_needed" || notification.interactionKind !== "request_confirmation" || !confirmation) return [];
  const title = notification.interactionTitle ? `*${truncateText(notification.interactionTitle, 220)}*\n` : "";
  const summary = notification.interactionSummary ? `\n_${truncateText(notification.interactionSummary, 450)}_` : "";
  const details = confirmation.detailsMarkdown ? `\n>${truncateText(confirmation.detailsMarkdown, 900).replace(/\n/g, "\n>")}` : "";
  return [section(`${title}*Confirmation requested*\n${truncateText(confirmation.prompt, 900)}${summary}${details}`)];
}

function renderInteractionCheckboxConfirmation(notification: NormalizedNotification) {
  const confirmation = notification.interactionCheckboxConfirmation;
  if (notification.kind !== "human.input_needed" || notification.interactionKind !== "request_checkbox_confirmation" || !confirmation) return [];
  const title = notification.interactionTitle ? `*${truncateText(notification.interactionTitle, 220)}*\n` : "";
  const summary = notification.interactionSummary ? `\n_${truncateText(notification.interactionSummary, 450)}_` : "";
  const details = confirmation.detailsMarkdown ? `\n>${truncateText(confirmation.detailsMarkdown, 900).replace(/\n/g, "\n>")}` : "";
  const min = confirmation.minSelected ?? 0;
  const max = confirmation.maxSelected ?? null;
  const bounds = max !== null
    ? `Select ${min === max ? min : `${min}–${max}`} option${max === 1 ? "" : "s"}.`
    : min > 0
      ? `Select at least ${min} option${min === 1 ? "" : "s"}.`
      : "Select any options that apply.";
  const blocks = [section(`${title}*Checkbox confirmation requested*\n${truncateText(confirmation.prompt, 900)}${summary}${details}\n_${bounds}_`)];
  if (confirmation.options.length <= 10) {
    blocks.push(inputBlock(
      checkboxConfirmationBlockId(),
      "Options",
      checkboxes(ACTION_IDS.interactionCheckboxSelect, confirmation.options, confirmation.defaultSelectedOptionIds ?? []),
      undefined,
      min === 0,
    ));
  } else {
    blocks.push(section("_This confirmation has more options than Slack can show inline. Open the issue to choose them._"));
  }
  return blocks;
}

function renderInteractionSuggestedTasks(notification: NormalizedNotification) {
  const suggested = notification.interactionSuggestedTasks;
  if (notification.kind !== "human.input_needed" || notification.interactionKind !== "suggest_tasks" || !suggested) return [];
  const visibleTasks = visibleSuggestedTasks(suggested.tasks);
  const title = notification.interactionTitle ? `*${truncateText(notification.interactionTitle, 220)}*\n` : "";
  const summary = notification.interactionSummary ? `\n_${truncateText(notification.interactionSummary, 450)}_` : "";
  const taskLines = visibleTasks.slice(0, 6).map((task, index) => {
    const meta = [task.priority, task.workMode].filter(Boolean).join(" · ");
    const description = task.description ? ` — ${truncateText(task.description, 160)}` : "";
    const parent = task.parentClientKey ? ` _(requires ${task.parentClientKey})_` : "";
    return `${index + 1}. *${truncateText(task.title, 160)}*${meta ? ` _${meta}_` : ""}${parent}${description}`;
  }).join("\n");
  const hiddenCount = suggested.tasks.length - visibleTasks.length;
  const hiddenNote = hiddenCount > 0 ? `\n_${hiddenCount} hidden/internal suggestion${hiddenCount === 1 ? "" : "s"} omitted from Slack._` : "";
  const tooMany = visibleTasks.length > 10;
  const blocks = [section(`${title}*Suggested tasks*${summary}\n${taskLines || "Open the issue to review suggested tasks."}${hiddenNote}`)];
  if (visibleTasks.length > 0 && !tooMany) {
    blocks.push(inputBlock(
      suggestedTasksBlockId(),
      "Tasks to create",
      checkboxes(ACTION_IDS.suggestedTasksSelect, visibleTasks.map((task) => ({ id: task.clientKey, label: task.title })), visibleTasks.map((task) => task.clientKey)),
      "Uncheck anything you do not want created.",
      false,
    ));
  } else if (tooMany) {
    blocks.push(section("_This interaction has more task suggestions than Slack can show inline. Open the issue to review and create them._"));
  }
  return blocks;
}

function visibleSuggestedTasks(tasks: SuggestedTaskDraft[]): SuggestedTaskDraft[] {
  return tasks.filter((task) => task.hiddenInPreview !== true);
}

function renderInteractionQuestions(notification: NormalizedNotification) {
  const questions = notification.interactionQuestions ?? [];
  if (notification.kind !== "human.input_needed" || questions.length === 0) return [];
  const title = notification.interactionTitle ? `*${truncateText(notification.interactionTitle, 220)}*\n` : "";
  return questions.slice(0, 3).flatMap((question, index) => {
    const required = question.required ? " · required" : "";
    const help = question.helpText ? `\n_${truncateText(question.helpText, 450)}_` : "";
    const optionElement = question.selectionMode === "multi"
      ? checkboxes(interactionOptionActionId(index), question.options)
      : radioButtons(interactionOptionActionId(index), question.options);
    return [
      section(`${title}*Question ${index + 1}${required}*\n${truncateText(question.prompt, 500)}${help}`),
      inputBlock(
        interactionOptionBlockId(index),
        question.selectionMode === "multi" ? "Pick one or more" : "Pick one",
        optionElement,
      ),
      inputBlock(
        interactionOtherBlockId(index),
        "Other",
        plainTextInput(interactionOtherActionId(index), "Type your answer", true),
        "Use this when none of the listed options fits.",
      ),
    ];
  });
}

function renderAnswerButtons(notification: NormalizedNotification): Array<Record<string, unknown>> {
  if (notification.kind !== "human.input_needed" || !notification.issueId || !notification.interactionId) return [];
  const questions = notification.interactionQuestions?.slice(0, 3) ?? [];
  if (questions.length === 0) return [];
  return [button(
    "Send answer",
    ACTION_IDS.interactionSubmit,
    JSON.stringify({
      issueId: notification.issueId,
      interactionId: notification.interactionId,
      companyPrefix: notification.companyPrefix,
      questions: questions.map((question, index) => ({
        id: question.id,
        selectionMode: question.selectionMode,
        required: question.required === true,
        optionActionId: interactionOptionActionId(index),
        otherActionId: interactionOtherActionId(index),
      })),
    }),
    "primary",
  )];
}

function renderSuggestedTaskButtons(notification: NormalizedNotification): Array<Record<string, unknown>> {
  const suggested = notification.interactionSuggestedTasks;
  if (notification.kind !== "human.input_needed" || notification.interactionKind !== "suggest_tasks" || !notification.issueId || !notification.interactionId || !suggested) return [];
  const visibleTasks = visibleSuggestedTasks(suggested.tasks);
  const supportsInlineAccept = visibleTasks.length > 0 && visibleTasks.length <= 10;
  const value = JSON.stringify({
    issueId: notification.issueId,
    interactionId: notification.interactionId,
    companyPrefix: notification.companyPrefix,
    kind: "suggest_tasks",
    optionActionId: ACTION_IDS.suggestedTasksSelect,
    taskClientKeys: visibleTasks.map((task) => task.clientKey),
    taskParentClientKeys: Object.fromEntries(visibleTasks.filter((task) => task.parentClientKey).map((task) => [task.clientKey, task.parentClientKey])),
  });
  return [
    ...(supportsInlineAccept ? [button("Create selected tasks", ACTION_IDS.interactionAccept, value, "primary")] : []),
    button("Reject suggestions", ACTION_IDS.interactionReject, value, "danger"),
  ];
}

function renderConfirmationButtons(notification: NormalizedNotification): Array<Record<string, unknown>> {
  const confirmation = notification.interactionKind === "request_checkbox_confirmation"
    ? notification.interactionCheckboxConfirmation
    : notification.interactionConfirmation;
  if (notification.kind !== "human.input_needed" || !notification.issueId || !notification.interactionId || !confirmation) return [];
  if (notification.interactionKind !== "request_confirmation" && notification.interactionKind !== "request_checkbox_confirmation") return [];
  const checkbox = notification.interactionKind === "request_checkbox_confirmation" ? notification.interactionCheckboxConfirmation : undefined;
  const supportsInlineAccept = !checkbox || checkbox.options.length <= 10;
  const value = JSON.stringify({
    issueId: notification.issueId,
    interactionId: notification.interactionId,
    companyPrefix: notification.companyPrefix,
    kind: notification.interactionKind,
    rejectRequiresReason: confirmation.rejectRequiresReason === true,
    title: truncateText(notification.interactionTitle ?? notification.title, 180),
    identifier: notification.identifier ? truncateText(notification.identifier, 80) : undefined,
    prompt: truncateText(confirmation.prompt, 360),
    summary: notification.interactionSummary ? truncateText(notification.interactionSummary, 160) : undefined,
    detailsMarkdown: confirmation.detailsMarkdown ? truncateText(confirmation.detailsMarkdown, 320) : undefined,
    acceptLabel: confirmation.acceptLabel ? truncateText(confirmation.acceptLabel, 75) : undefined,
    rejectLabel: confirmation.rejectLabel ? truncateText(confirmation.rejectLabel, 75) : undefined,
    ...(checkbox ? {
      optionActionId: ACTION_IDS.interactionCheckboxSelect,
      minSelected: checkbox.minSelected ?? 0,
      maxSelected: checkbox.maxSelected ?? null,
      defaultSelectedOptionIds: checkbox.defaultSelectedOptionIds ?? [],
    } : {}),
  });
  const actions = supportsInlineAccept ? [button(confirmation.acceptLabel ?? "Accept", ACTION_IDS.interactionAccept, value, "primary")] : [];
  const rejectActionId = confirmation.rejectRequiresReason === true
    ? ACTION_IDS.interactionRejectStart
    : ACTION_IDS.interactionReject;
  if (rejectActionId) actions.push(button(confirmation.rejectLabel ?? "Reject", rejectActionId, value, "danger"));
  return actions;
}

function suggestedTasksBlockId(): string {
  return "pc_interaction_suggested_tasks";
}

function checkboxConfirmationBlockId(): string {
  return "pc_interaction_checkbox_confirmation";
}

function interactionOptionBlockId(index: number): string {
  return `pc_interaction_option_${index + 1}`;
}

function interactionOtherBlockId(index: number): string {
  return `pc_interaction_other_${index + 1}`;
}

function interactionOptionActionId(index: number): string {
  return `${ACTION_IDS.interactionOptionSelect}.${index + 1}`;
}

function interactionOtherActionId(index: number): string {
  return `${ACTION_IDS.interactionOtherText}.${index + 1}`;
}

function isEnrichedQuestionNotification(notification: NormalizedNotification): boolean {
  return notification.kind === "human.input_needed" && (notification.interactionQuestions?.length ?? 0) > 0;
}

function isEnrichedConfirmationNotification(notification: NormalizedNotification): boolean {
  return notification.kind === "human.input_needed"
    && notification.interactionKind === "request_confirmation"
    && Boolean(notification.interactionConfirmation?.prompt);
}

function isEnrichedCheckboxConfirmationNotification(notification: NormalizedNotification): boolean {
  return notification.kind === "human.input_needed"
    && notification.interactionKind === "request_checkbox_confirmation"
    && Boolean(notification.interactionCheckboxConfirmation?.prompt)
    && (notification.interactionCheckboxConfirmation?.options.length ?? 0) > 0;
}

function isEnrichedSuggestedTasksNotification(notification: NormalizedNotification): boolean {
  return notification.kind === "human.input_needed"
    && notification.interactionKind === "suggest_tasks"
    && (notification.interactionSuggestedTasks?.tasks.length ?? 0) > 0;
}

function issueHeading(notification: NormalizedNotification): string {
  switch (notification.kind) {
    case "human.input_needed": return isEnrichedSuggestedTasksNotification(notification) ? `*Suggested tasks for ${truncateText(notification.identifier ?? "human", 80)}* :clipboard:` : isEnrichedCheckboxConfirmationNotification(notification) ? `*Checklist confirmation for ${truncateText(notification.identifier ?? "human", 80)}* :white_check_mark:` : isEnrichedConfirmationNotification(notification) ? `*Confirmation for ${truncateText(notification.identifier ?? "human", 80)}* :white_check_mark:` : isEnrichedQuestionNotification(notification) ? `*Question for ${truncateText(notification.identifier ?? "human", 80)}* :question:` : "*Human input needed* :raised_hand:";
    case "issue.assigned": return "*Issue assigned / wakeup requested* :bell:";
    case "issue.blocked": return "*Issue blocked* :no_entry:";
    case "issue.unblocked": return "*Issue unblocked* :white_check_mark:";
    case "issue.completed": return "*Issue completed* :white_check_mark:";
    default: return "*Issue update*";
  }
}

function plainKind(notification: NormalizedNotification): string {
  switch (notification.kind) {
    case "human.input_needed": return isEnrichedSuggestedTasksNotification(notification) ? "Suggested tasks for human" : isEnrichedCheckboxConfirmationNotification(notification) ? "Checklist confirmation for human" : isEnrichedConfirmationNotification(notification) ? "Confirmation for human" : isEnrichedQuestionNotification(notification) ? "Question for human" : "Human input needed";
    case "issue.assigned": return "Issue assigned";
    case "issue.blocked": return "Issue blocked";
    case "issue.unblocked": return "Issue unblocked";
    case "issue.completed": return "Issue completed";
    default: return "Issue update";
  }
}

import { ACTION_IDS, DEFAULT_PAPERCLIP_BASE_URL } from "../constants.js";
import type { SlackMessage, SlackNotificationsConfig } from "../types.js";
import type { SlackActionResult, SocketContext } from "./types.js";
import { parseInteractionActionValue, parseInteractionAnswerValue, parseInteractionSubmitValue } from "./action-values.js";
import { selectedMultiValues, selectedOptionIdsFromState, stateElement } from "./slack-state.js";
import { fetchCurrentConfirmationReplacement, fetchCurrentInteractionRecord, fetchResolvedInteractionMessage, interactionAnsweredMessage, interactionCheckboxConfirmationPendingMessage, interactionConfirmationDeclineMessage, interactionConfirmationPendingMessage, interactionConfirmationReplacement, replaceOriginalResponse } from "./replacements.js";
import { issueInteractionPath, recordField, safeJson, simpleMessage, stringField } from "./utils.js";

interface InteractionAnswerSummary {
  questionId: string;
  optionIds: string[];
  otherText?: string;
}

function summarizeInteractionAnswers(answers: InteractionAnswerSummary[]): string {
  const parts = answers.map((answer) => {
    const selected = answer.optionIds.length > 0 ? answer.optionIds.join(", ") : "Other";
    const other = answer.otherText ? ` — ${answer.otherText}` : "";
    return `- ${answer.questionId}: ${selected}${other}`;
  });
  return `Answered from Slack:\n${parts.join("\n")}`;
}

export async function handleInteractionSubmitAction(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  body: Record<string, unknown>,
  value?: string,
): Promise<SlackActionResult> {
  const submit = parseInteractionSubmitValue(value);
  if (!submit.issueId || !submit.interactionId || submit.questions.length === 0) return null;
  const answers = submit.questions.map((question) => {
    const optionIds = selectedOptionIdsFromState(body, question.optionActionId, question.selectionMode);
    const otherText = stringField(stateElement(body, question.otherActionId)?.value)?.trim();
    return {
      questionId: question.id,
      optionIds,
      ...(otherText ? { otherText } : {}),
    };
  });
  const missingRequired = submit.questions.find((question, index) => {
    if (!question.required) return false;
    const answer = answers[index];
    return answer.optionIds.length === 0 && !answer.otherText;
  });
  const baseUrl = (config.paperclipBaseUrl || DEFAULT_PAPERCLIP_BASE_URL).replace(/\/$/, "");
  const issueUrl = `${baseUrl}${issueInteractionPath(submit.issueId, submit.companyPrefix)}`;
  if (missingRequired) {
    return simpleMessage("Answer needs a response", `Question \`${missingRequired.id}\` is required. Pick an option or type an Other answer, then send again.`, config, issueUrl);
  }
  const nonEmptyAnswers = answers.filter((answer) => answer.optionIds.length > 0 || answer.otherText);
  if (nonEmptyAnswers.length === 0) {
    return simpleMessage("Answer needs a response", "Pick an option or type an Other answer, then send again.", config, issueUrl);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.paperclipApiToken) headers.Authorization = `Bearer ${config.paperclipApiToken}`;
  try {
    const response = await fetch(
      `${baseUrl}/api/issues/${encodeURIComponent(submit.issueId)}/interactions/${encodeURIComponent(submit.interactionId)}/respond`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          answers: nonEmptyAnswers,
          summaryMarkdown: summarizeInteractionAnswers(nonEmptyAnswers),
        }),
      },
    );
    const ok = response.status >= 200 && response.status < 300;
    await ctx.metrics.write("slack_interaction_answer_completed", 1, { ok: String(ok), status: String(response.status), mode: "form" });
    if (ok) {
      const summaryMarkdown = summarizeInteractionAnswers(nonEmptyAnswers);
      return replaceOriginalResponse(interactionAnsweredMessage("Question answered", summaryMarkdown, issueUrl));
    }
    if (response.status === 409) {
      const resolved = await fetchResolvedInteractionMessage(ctx, baseUrl, headers, submit, issueUrl);
      return resolved ?? replaceOriginalResponse(
        interactionAnsweredMessage("Already answered", "This question has already been answered in Paperclip.", issueUrl),
      );
    }
    return simpleMessage(
      "Answer failed",
      `Paperclip returned HTTP ${response.status} for interaction \`${submit.interactionId}\`. Open the issue to finish it manually.`,
      config,
      issueUrl,
    );
  } catch (error) {
    ctx.logger.warn("Slack issue-thread interaction form submit failed", {
      issueId: submit.issueId,
      interactionId: submit.interactionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return simpleMessage(
      "Answer failed",
      `I could not reach the Paperclip interaction endpoint for \`${submit.interactionId}\`: ${error instanceof Error ? error.message : String(error)}`,
      config,
      issueUrl,
    );
  }
}

export async function handleInteractionConfirmationAction(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  body: Record<string, unknown>,
  actionId: string,
  value?: string,
): Promise<SlackActionResult> {
  const interaction = parseInteractionActionValue(value);
  if (!interaction.issueId || !interaction.interactionId) return null;
  const baseUrl = (config.paperclipBaseUrl || DEFAULT_PAPERCLIP_BASE_URL).replace(/\/$/, "");
  const issueUrl = `${baseUrl}${issueInteractionPath(interaction.issueId, interaction.companyPrefix)}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.paperclipApiToken) headers.Authorization = `Bearer ${config.paperclipApiToken}`;
  if (actionId === ACTION_IDS.interactionRejectStart) {
    return replaceOriginalResponse(interactionConfirmationDeclineMessage(interaction, issueUrl));
  }
  if (actionId === ACTION_IDS.interactionRejectCancel) {
    if (interaction.kind === "request_checkbox_confirmation") {
      const record = await fetchCurrentInteractionRecord(ctx, baseUrl, headers, interaction, "Slack checkbox confirmation cancel");
      return replaceOriginalResponse(interactionCheckboxConfirmationPendingMessage(record, interaction, issueUrl));
    }
    return replaceOriginalResponse(interactionConfirmationPendingMessage(interaction, issueUrl));
  }
  const route = actionId === ACTION_IDS.interactionAccept ? "accept" : "reject";
  const checkboxOptionIds = route === "accept" && interaction.kind === "request_checkbox_confirmation"
    ? selectedMultiValues(body, interaction.optionActionId ?? ACTION_IDS.interactionCheckboxSelect, interaction.defaultSelectedOptionIds)
    : [];
  const suggestedTaskClientKeys = route === "accept" && interaction.kind === "suggest_tasks"
    ? selectedMultiValues(body, interaction.optionActionId ?? ACTION_IDS.suggestedTasksSelect, interaction.taskClientKeys)
    : [];
  const rejectReason = route === "reject"
    ? stringField(stateElement(body, ACTION_IDS.interactionRejectReason)?.value)?.trim()
    : undefined;
  if (route === "accept" && interaction.kind === "suggest_tasks") {
    if (suggestedTaskClientKeys.length === 0) {
      return simpleMessage("Selection needed", "Pick at least one suggested task, then create selected tasks again.", config, issueUrl);
    }
    const selectedSet = new Set(suggestedTaskClientKeys);
    const missingParent = suggestedTaskClientKeys.find((clientKey) => {
      const parent = interaction.taskParentClientKeys[clientKey];
      return parent && !selectedSet.has(parent);
    });
    if (missingParent) {
      const parent = interaction.taskParentClientKeys[missingParent];
      return simpleMessage("Parent task needed", `Suggested task \`${missingParent}\` requires parent \`${parent}\`; select both or open the issue to review.`, config, issueUrl);
    }
  }
  if (route === "accept" && interaction.kind === "request_checkbox_confirmation") {
    const selectedCount = checkboxOptionIds.length;
    const minSelected = interaction.minSelected ?? 0;
    const maxSelected = interaction.maxSelected;
    if (selectedCount < minSelected) {
      return simpleMessage("Selection needed", `Pick at least ${minSelected} option${minSelected === 1 ? "" : "s"}, then accept again.`, config, issueUrl);
    }
    if (typeof maxSelected === "number" && selectedCount > maxSelected) {
      return simpleMessage("Too many selections", `Pick at most ${maxSelected} option${maxSelected === 1 ? "" : "s"}, then accept again.`, config, issueUrl);
    }
  }
  if (route === "reject" && interaction.rejectRequiresReason === true && !rejectReason) {
    return simpleMessage("Decline needs notes", "Add a short reason in Decline notes, then send back again.", config, issueUrl);
  }
  try {
    const response = await fetch(
      `${baseUrl}/api/issues/${encodeURIComponent(interaction.issueId)}/interactions/${encodeURIComponent(interaction.interactionId)}/${route}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(route === "reject"
          ? { reason: rejectReason || (interaction.kind === "suggest_tasks" ? "Rejected suggested tasks from Slack." : "Rejected from Slack.") }
          : interaction.kind === "request_checkbox_confirmation"
            ? { selectedOptionIds: checkboxOptionIds }
            : interaction.kind === "suggest_tasks"
              ? { selectedClientKeys: suggestedTaskClientKeys }
              : {}),
      },
    );
    const ok = response.status >= 200 && response.status < 300;
    await ctx.metrics.write("slack_interaction_confirmation_completed", 1, { actionId, ok: String(ok), status: String(response.status), route });
    if (ok) {
      const record = recordField(await safeJson(response));
      return interactionConfirmationReplacement(record, route === "accept" ? "accepted" : "rejected", issueUrl);
    }
    if (response.status === 409 || response.status === 422) {
      const resolved = await fetchCurrentConfirmationReplacement(ctx, baseUrl, headers, interaction, issueUrl);
      if (resolved) return resolved;
    }
    return simpleMessage(
      route === "accept" ? "Accept failed" : "Reject failed",
      `Paperclip returned HTTP ${response.status} for interaction \`${interaction.interactionId}\`. Open the issue to finish it manually.`,
      config,
      issueUrl,
    );
  } catch (error) {
    ctx.logger.warn("Slack issue-thread confirmation action failed", {
      issueId: interaction.issueId,
      interactionId: interaction.interactionId,
      actionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return simpleMessage(
      route === "accept" ? "Accept failed" : "Reject failed",
      `I could not reach the Paperclip interaction endpoint for \`${interaction.interactionId}\`: ${error instanceof Error ? error.message : String(error)}`,
      config,
      issueUrl,
    );
  }
}

export async function handleInteractionAnswerAction(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  value?: string,
): Promise<SlackMessage | null> {
  const answer = parseInteractionAnswerValue(value);
  if (!answer.issueId || !answer.interactionId || !answer.questionId || !answer.optionId) return null;
  const baseUrl = (config.paperclipBaseUrl || DEFAULT_PAPERCLIP_BASE_URL).replace(/\/$/, "");
  const issueUrl = `${baseUrl}${issueInteractionPath(answer.issueId, answer.companyPrefix)}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.paperclipApiToken) headers.Authorization = `Bearer ${config.paperclipApiToken}`;
  try {
    const response = await fetch(
      `${baseUrl}/api/issues/${encodeURIComponent(answer.issueId)}/interactions/${encodeURIComponent(answer.interactionId)}/respond`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          answers: [{ questionId: answer.questionId, optionIds: [answer.optionId] }],
          summaryMarkdown: `Answered from Slack: ${answer.optionLabel ?? answer.optionId}`,
        }),
      },
    );
    const ok = response.status >= 200 && response.status < 300;
    await ctx.metrics.write("slack_interaction_answer_completed", 1, { ok: String(ok), status: String(response.status) });
    if (ok) return simpleMessage("Answer sent", `Paperclip recorded your answer${answer.optionLabel ? `: *${answer.optionLabel}*` : ""}.`, config, issueUrl);
    return simpleMessage(
      "Answer failed",
      `Paperclip returned HTTP ${response.status} for interaction \`${answer.interactionId}\`. Open the issue to finish it manually.`,
      config,
      issueUrl,
    );
  } catch (error) {
    ctx.logger.warn("Slack issue-thread interaction answer failed", {
      issueId: answer.issueId,
      interactionId: answer.interactionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return simpleMessage(
      "Answer failed",
      `I could not reach the Paperclip interaction endpoint for \`${answer.interactionId}\`: ${error instanceof Error ? error.message : String(error)}`,
      config,
      issueUrl,
    );
  }
}

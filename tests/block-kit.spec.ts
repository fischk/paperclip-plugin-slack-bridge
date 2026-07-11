import { describe, expect, it } from "vitest";
import { ACTION_IDS } from "../src/constants.js";
import { renderNotification } from "../src/block-kit/index.js";
import { assertSlackMessageBounds } from "../src/block-kit/limits.js";
import type { NormalizedNotification, SlackNotificationsConfig } from "../src/types.js";

const config: SlackNotificationsConfig = {
  slackBotTokenRef: "secret-bot",
  defaultChannelId: "C123",
  paperclipBaseUrl: "http://127.0.0.1:3100",
};


function collectButtonValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectButtonValues);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const ownValue = record.type === "button" && typeof record.value === "string" ? [record.value] : [];
  return ownValue.concat(Object.values(record).flatMap(collectButtonValues));
}

function collectButtonTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectButtonTexts);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const text = record.text && typeof record.text === "object" ? (record.text as Record<string, unknown>).text : undefined;
  const ownText = record.type === "button" && typeof text === "string" ? [text] : [];
  return ownText.concat(Object.values(record).flatMap(collectButtonTexts));
}

function notification(kind: NormalizedNotification["kind"]): NormalizedNotification {
  const base: NormalizedNotification = {
    kind,
    eventId: `evt-${kind}`,
    eventType: kind,
    occurredAt: "2026-06-27T00:00:00.000Z",
    companyId: "company-1",
    companyPrefix: "COM",
    entityId: "entity-1",
    issueId: "issue-1",
    runId: "run-1",
    approvalId: "approval-1",
    identifier: "PRO-1",
    title: "Build Slack notifications",
    description: "A concise description of the work.",
    agentName: "Builder",
    projectName: "Plugin Work",
    blockerIds: ["PRO-0"],
    error: "Command exited non-zero",
    raw: {} as NormalizedNotification["raw"],
  };
  if (kind === "approval.created" || kind === "approval.decided") {
    return {
      ...base,
      approvalType: "request_board_approval",
      approvalTitle: "Board Approval: Ratify package id",
      summary: "This approval asks the board to ratify the final package id.",
      recommendedAction: "Approve com.ephemeralstudios.gstack and let the release engineer continue.",
      risks: ["Package id is permanent once created.", "Play upload chain remains blocked until approved."],
      requestedByName: "CEO",
      linkedIssues: [{ id: "issue-1", identifier: "GST-6", title: "Play Console critical path" }],
    };
  }
  return base;
}

describe("Block Kit renderers", () => {
  it.each(["approval.created", "approval.decided", "human.input_needed", "issue.assigned", "issue.blocked", "issue.completed", "run.failed", "run.finished"] as const)("renders bounded deterministic %s card", (kind) => {
    const message = renderNotification(notification(kind), config);
    expect(message.text).toBeTruthy();
    expect(message.blocks?.length).toBeGreaterThan(0);
    expect(() => assertSlackMessageBounds(message)).not.toThrow();
    expect(JSON.stringify(message)).toMatchSnapshot();
  });

  it("renders interactive ask-user-question options on human input cards", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      interactionId: "interaction-1",
      interactionTitle: "Slack HITL human input proof",
      interactionQuestions: [{
        id: "next_step",
        prompt: "Which proof path should the agent take next?",
        helpText: "This is a deterministic test interaction.",
        selectionMode: "single",
        required: true,
        options: [
          { id: "approve_path", label: "Proceed with approval path" },
          { id: "revise_path", label: "Request revision path" },
        ],
      }],
    }, config);
    const json = JSON.stringify(message);
    const visibleText = JSON.stringify(message.blocks?.map((block) => ({ text: block.text, fields: block.fields })));
    expect(json).toContain("Which proof path should the agent take next?");
    expect(json).toContain("Proceed with approval path");
    expect(json).toContain("Request revision path");
    expect(visibleText).toContain("Question for PRO-1");
    expect(visibleText).not.toContain("A concise description of the work.");
    expect(visibleText).not.toContain("interaction-1");
    expect(visibleText).not.toContain("*Action*");
    expect(json).toContain("radio_buttons");
    expect(json).toContain("plain_text_input");
    expect(json).toContain("Other");
    expect(json).toContain("Send answer");
    expect(json).toContain(ACTION_IDS.interactionSubmit);
    expect(json).toContain(ACTION_IDS.interactionOptionSelect);
    expect(json).toContain(ACTION_IDS.interactionOtherText);
    expect(json).not.toContain(ACTION_IDS.interactionAnswerOption);
    expect(json).toContain("approve_path");
    expect(() => assertSlackMessageBounds(message)).not.toThrow();
  });

  it("renders request-confirmation interactions as native Slack controls", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      interactionId: "interaction-confirm-1",
      interactionKind: "request_confirmation",
      interactionTitle: "Confirm deployment plan",
      interactionSummary: "Agent needs a yes/no decision.",
      interactionConfirmation: {
        prompt: "Should the agent apply this plan?",
        detailsMarkdown: "Plan touches only Slack notification copy.",
        acceptLabel: "Apply plan",
        rejectLabel: "Do not apply",
        rejectRequiresReason: false,
      },
    }, config);
    const json = JSON.stringify(message);
    const visibleText = JSON.stringify(message.blocks?.map((block) => ({ text: block.text, fields: block.fields })));
    expect(visibleText).toContain("Confirmation for PRO-1");
    expect(json).toContain("Should the agent apply this plan?");
    expect(json).toContain("Plan touches only Slack notification copy.");
    expect(json).toContain("Apply plan");
    expect(json).toContain("Do not apply");
    expect(json).toContain(ACTION_IDS.interactionAccept);
    expect(json).toContain(ACTION_IDS.interactionReject);
    expect(json).not.toContain(ACTION_IDS.interactionSubmit);
    expect(() => assertSlackMessageBounds(message)).not.toThrow();
  });

  it("renders a send-back starter button without showing decline notes upfront", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      interactionId: "interaction-confirm-2",
      interactionKind: "request_confirmation",
      interactionConfirmation: {
        prompt: "Should the agent apply this plan?",
        acceptLabel: "Ship amber label proof",
        rejectLabel: "Return violet label proof",
        rejectRequiresReason: true,
      },
    }, config);
    const json = JSON.stringify(message);
    expect(json).toContain(ACTION_IDS.interactionAccept);
    expect(json).toContain(ACTION_IDS.interactionRejectStart);
    expect(json).toContain("Ship amber label proof");
    expect(json).toContain("Return violet label proof");
    expect(json).not.toContain("Use the send-back action");
    expect(json).not.toContain(ACTION_IDS.interactionRejectReason);
    expect(json).not.toContain("Decline notes");
  });

  it("keeps request-confirmation action payloads within Slack button value limits", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      title: "Human input needed for " + "Long title ".repeat(80),
      identifier: "COM-" + "9".repeat(120),
      interactionId: "interaction-confirm-long",
      interactionKind: "request_confirmation",
      interactionTitle: "Long confirmation title ".repeat(40),
      interactionSummary: "Long summary ".repeat(80),
      interactionConfirmation: {
        prompt: "Long prompt ".repeat(140),
        detailsMarkdown: "Long details ".repeat(120),
        acceptLabel: "Approve with a very specific and intentionally verbose label ".repeat(3),
        rejectLabel: "Return with a very specific and intentionally verbose label ".repeat(3),
        rejectRequiresReason: true,
      },
    }, config);

    const values = collectButtonValues(message);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(2000);
    }
  });

  it("renders request-checkbox-confirmation interactions as Slack checkbox controls", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      interactionId: "interaction-check-1",
      interactionKind: "request_checkbox_confirmation",
      interactionTitle: "Confirm checklist",
      interactionSummary: "Agent needs selected approvals.",
      interactionCheckboxConfirmation: {
        prompt: "Which checks may the agent proceed with?",
        detailsMarkdown: "Only select checks that are ready.",
        acceptLabel: "Proceed with selected",
        rejectLabel: "Stop",
        rejectRequiresReason: false,
        minSelected: 1,
        maxSelected: 2,
        defaultSelectedOptionIds: ["docs"],
        options: [
          { id: "docs", label: "Docs are updated" },
          { id: "tests", label: "Tests are green" },
          { id: "release", label: "Release is approved" },
        ],
      },
    }, config);
    const json = JSON.stringify(message);
    const visibleText = JSON.stringify(message.blocks?.map((block) => ({ text: block.text, fields: block.fields })));
    expect(visibleText).toContain("Checklist confirmation for PRO-1");
    expect(json).toContain("Which checks may the agent proceed with?");
    expect(json).toContain("Only select checks that are ready.");
    expect(json).toContain("Select 1–2 options.");
    expect(json).toContain("checkboxes");
    expect(json).toContain("initial_options");
    expect(json).toContain("Docs are updated");
    expect(json).toContain("Proceed with selected");
    expect(json).toContain("Stop");
    expect(json).toContain(ACTION_IDS.interactionCheckboxSelect);
    expect(json).toContain(ACTION_IDS.interactionAccept);
    expect(json).toContain(ACTION_IDS.interactionReject);
    expect(json).not.toContain(ACTION_IDS.interactionSubmit);
    expect(() => assertSlackMessageBounds(message)).not.toThrow();
  });

  it("renders a checkbox send-back starter button when decline notes are required", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      interactionId: "interaction-check-reason",
      interactionKind: "request_checkbox_confirmation",
      interactionTitle: "Confirm checklist",
      interactionCheckboxConfirmation: {
        prompt: "Which checks may the agent proceed with?",
        acceptLabel: "Proceed with selected",
        rejectLabel: "Return with notes",
        rejectRequiresReason: true,
        minSelected: 1,
        maxSelected: 2,
        options: [
          { id: "docs", label: "Docs are updated" },
          { id: "tests", label: "Tests are green" },
        ],
      },
    }, config);
    const json = JSON.stringify(message);
    const buttonTexts = JSON.stringify(collectButtonTexts(message));
    expect(buttonTexts).toContain("Proceed with selected");
    expect(buttonTexts).toContain("Return with notes");
    expect(json).toContain(ACTION_IDS.interactionRejectStart);
    expect(json).not.toContain(ACTION_IDS.interactionReject);
    expect(json).not.toContain("Declining this confirmation requires a reason");
    expect(json).not.toContain("Decline notes");
  });

  it("renders suggest-tasks interactions as Slack task-selection controls", () => {
    const message = renderNotification({
      ...notification("human.input_needed"),
      interactionId: "interaction-suggest-1",
      interactionKind: "suggest_tasks",
      interactionTitle: "Review follow-up tasks",
      interactionSummary: "Agent suggested next implementation work.",
      interactionSuggestedTasks: {
        tasks: [
          { clientKey: "root", title: "Create root follow-up", description: "Add the root issue first.", priority: "high", workMode: "planning" },
          { clientKey: "child", parentClientKey: "root", title: "Create nested follow-up", description: "Depends on root." },
          { clientKey: "hidden", title: "Hidden internal task", hiddenInPreview: true },
        ],
      },
    }, config);
    const json = JSON.stringify(message);
    const visibleText = JSON.stringify(message.blocks?.map((block) => ({ text: block.text, fields: block.fields })));
    expect(visibleText).toContain("Suggested tasks for PRO-1");
    expect(json).toContain("Review follow-up tasks");
    expect(json).toContain("Create root follow-up");
    expect(json).toContain("Create nested follow-up");
    expect(json).toContain("requires root");
    expect(json).toContain("hidden/internal");
    expect(json).toContain("checkboxes");
    expect(json).toContain("initial_options");
    expect(json).toContain("Create selected tasks");
    expect(json).toContain("Reject suggestions");
    expect(json).toContain(ACTION_IDS.suggestedTasksSelect);
    expect(json).toContain(ACTION_IDS.interactionAccept);
    expect(json).toContain(ACTION_IDS.interactionReject);
    expect(json).not.toContain("Hidden internal task");
    expect(() => assertSlackMessageBounds(message)).not.toThrow();
  });

  it("uses stable action ids on approval cards", () => {
    const json = JSON.stringify(renderNotification(notification("approval.created"), config));
    expect(json).toContain(ACTION_IDS.approvalApprove);
    expect(json).toContain(ACTION_IDS.approvalDeny);
    expect(json).toContain(ACTION_IDS.approvalRequestRevision);
    expect(json).toContain(ACTION_IDS.approvalOpen);
    expect(json).toContain("/COM/approvals/approval-1");
    expect(json).toContain("Board Approval: Ratify package id");
    expect(json).toContain("Recommended action");
    expect(json).toContain("Package id is permanent once created");
    expect(json).toContain("GST-6");
  });

  it("collapses decided approval cards to a compact receipt", () => {
    const json = JSON.stringify(renderNotification({
      ...notification("approval.decided"),
      status: "approved",
      decisionNote: "Resolved as approved",
    }, config));
    expect(json).toContain("✅ Approved");
    expect(json).toContain("Board Approval: Ratify package id");
    expect(json).toContain("View in Paperclip");
    expect(json).not.toContain("Open in Paperclip");
    expect(json).not.toContain("Decision note");
    expect(json).not.toContain("Resolved as approved");
    expect(json).not.toContain(ACTION_IDS.approvalApprove);
  });
});

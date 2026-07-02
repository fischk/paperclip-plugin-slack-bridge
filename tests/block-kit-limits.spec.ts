// Proves the Slack platform-limit guards hold under hostile input.
// Slack hard limits: 3000 chars per section text, 50 blocks per message,
// 10 options per radio/checkbox group, 75 chars per option label.
import { describe, expect, it } from "vitest";
import { renderNotification } from "../src/block-kit/index.js";
import { assertSlackMessageBounds, truncateText, SLACK_MESSAGE_BLOCK_LIMIT, SLACK_SECTION_TEXT_LIMIT } from "../src/block-kit/limits.js";
import { checkboxes, radioButtons } from "../src/block-kit/common.js";
import type { NormalizedNotification, SlackNotificationsConfig } from "../src/types.js";

const config: SlackNotificationsConfig = {
  slackBotTokenRef: "secret-bot",
  defaultChannelId: "C0000000000",
  paperclipBaseUrl: "http://127.0.0.1:3100",
};

const HUGE = "x".repeat(10_000);

function hostileNotification(kind: NormalizedNotification["kind"]): NormalizedNotification {
  return {
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
    title: HUGE,
    description: HUGE,
    agentName: HUGE,
    projectName: HUGE,
    blockerIds: Array.from({ length: 40 }, (_, i) => `PRO-${i}`),
    error: HUGE,
    approvalType: "request_board_approval",
    approvalTitle: HUGE,
    summary: HUGE,
    recommendedAction: HUGE,
    risks: Array.from({ length: 25 }, () => HUGE),
    requestedByName: HUGE,
    linkedIssues: Array.from({ length: 30 }, (_, i) => ({ id: `issue-${i}`, identifier: `GST-${i}`, title: HUGE })),
    raw: {} as NormalizedNotification["raw"],
  };
}

describe("Block Kit limit guards", () => {
  it("truncateText respects the boundary exactly", () => {
    expect(truncateText("a".repeat(500))).toHaveLength(500);
    expect(truncateText("a".repeat(501))).toHaveLength(500);
    expect(truncateText("a".repeat(501)).endsWith("…")).toBe(true);
    expect(truncateText(undefined)).toBe("");
    expect(truncateText("  padded  ")).toBe("padded");
  });

  it("assertSlackMessageBounds rejects out-of-bounds messages (the guard guards)", () => {
    expect(() => assertSlackMessageBounds({
      text: "too many blocks",
      blocks: Array.from({ length: SLACK_MESSAGE_BLOCK_LIMIT + 1 }, () => ({ type: "section", text: { type: "mrkdwn", text: "hi" } })),
    })).toThrow(/too many blocks/);
    expect(() => assertSlackMessageBounds({
      text: "oversized section",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(SLACK_SECTION_TEXT_LIMIT + 1) } }],
    })).toThrow(/exceeds/);
  });

  it.each(["approval.created", "approval.decided", "human.input_needed", "issue.assigned", "issue.blocked", "issue.completed", "run.failed", "run.finished"] as const)(
    "renders %s within Slack bounds under 10k-char hostile input",
    (kind) => {
      const message = renderNotification(hostileNotification(kind), config);
      expect(() => assertSlackMessageBounds(message)).not.toThrow();
      expect(message.blocks?.length ?? 0).toBeLessThanOrEqual(SLACK_MESSAGE_BLOCK_LIMIT);
      for (const block of message.blocks ?? []) {
        if (block.text?.text) expect(block.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
        for (const field of block.fields ?? []) expect(field.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
      }
    },
  );

  it("caps ask-user-question cards: max 3 questions rendered, bounds hold", () => {
    const message = renderNotification({
      ...hostileNotification("human.input_needed"),
      interactionId: "interaction-1",
      interactionTitle: HUGE,
      interactionQuestions: Array.from({ length: 12 }, (_, q) => ({
        id: `q-${q}`,
        prompt: HUGE,
        helpText: HUGE,
        selectionMode: "single" as const,
        required: true,
        options: Array.from({ length: 20 }, (_, o) => ({ id: `q${q}-o${o}`, label: HUGE })),
      })),
    }, config);
    expect(() => assertSlackMessageBounds(message)).not.toThrow();
    const json = JSON.stringify(message);
    expect(json).toContain("Question 3");
    expect(json).not.toContain("Question 4");
  });

  it("caps radio/checkbox groups at Slack's 10-option / 75-char-label limits", () => {
    const options = Array.from({ length: 20 }, (_, i) => ({ id: `opt-${i}`, label: HUGE }));
    for (const element of [radioButtons("act.radio", options), checkboxes("act.check", options, ["opt-1"])]) {
      const rendered = element.options as Array<{ text: { text: string } }>;
      expect(rendered).toHaveLength(10);
      for (const option of rendered) expect(option.text.text.length).toBeLessThanOrEqual(75);
    }
  });

  it("renders deterministically: same notification, identical output", () => {
    const input = hostileNotification("approval.created");
    expect(JSON.stringify(renderNotification(input, config))).toBe(JSON.stringify(renderNotification(input, config)));
  });
});

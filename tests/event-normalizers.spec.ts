import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { normalizeEvent } from "../src/event-normalizers.js";

function event(overrides: Partial<PluginEvent>): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "approval.created",
    occurredAt: "2026-06-27T00:00:00.000Z",
    companyId: "company-1",
    entityId: "entity-1",
    entityType: "approval",
    payload: {},
    ...overrides,
  } as PluginEvent;
}

describe("normalizeEvent", () => {
  it("normalizes approval requests", () => {
    const result = normalizeEvent(event({ payload: {
      approvalId: "approval-1",
      identifier: "COM-20",
      title: "Deploy?",
      approvalTitle: "Board Approval: Deploy?",
      agentName: "Release Agent",
      type: "request_board_approval",
      summary: "Deploy to production.",
      recommendedAction: "Approve deployment.",
      risks: ["Rollback may be needed."],
      linkedIssues: [{ id: "issue-1", identifier: "COM-20", title: "Deploy release" }],
    } }));
    expect(result).toMatchObject({
      kind: "approval.created",
      approvalId: "approval-1",
      title: "Deploy?",
      agentName: "Release Agent",
      approvalType: "request_board_approval",
      approvalTitle: "Board Approval: Deploy?",
      summary: "Deploy to production.",
      recommendedAction: "Approve deployment.",
      risks: ["Rollback may be needed."],
      linkedIssues: [{ id: "issue-1", identifier: "COM-20", title: "Deploy release" }],
      companyPrefix: "COM",
      url: "http://127.0.0.1:3100/COM/approvals/approval-1",
    });
  });

  it("normalizes human input needed plugin events", () => {
    const result = normalizeEvent(event({
      eventType: "plugin.paperclip-plugin-slack-bridge.human_input_needed",
      entityId: "issue-1",
      entityType: "issue",
      payload: { issueId: "issue-1", interactionId: "interaction-1", issueTitle: "Choose direction", actionLabel: "Answer question", reason: "pending_user_decision" },
    }));
    expect(result).toMatchObject({
      kind: "human.input_needed",
      issueId: "issue-1",
      interactionId: "interaction-1",
      title: "Choose direction",
      actionLabel: "Answer question",
      attentionReason: "pending_user_decision",
    });
  });

  it("normalizes run failures", () => {
    const result = normalizeEvent(event({
      eventType: "agent.run.failed",
      entityId: "run-1",
      entityType: "run",
      payload: { agentName: "Builder", error: "Tests failed", issueId: "issue-1" },
    }));
    expect(result).toMatchObject({ kind: "run.failed", runId: "run-1", issueId: "issue-1", error: "Tests failed" });
  });

  it("normalizes issue completion and ignores irrelevant issue updates", () => {
    expect(normalizeEvent(event({ eventType: "issue.updated", entityId: "issue-1", entityType: "issue", payload: { title: "Done", status: "done" } })))
      .toMatchObject({ kind: "issue.completed", issueId: "issue-1" });
    expect(normalizeEvent(event({ eventType: "issue.updated", payload: { title: "Still open", status: "todo" } }))).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalCreatedEventFromApi, humanLoopEventForIssue, pollHumanLoopAttention } from "../src/human-loop-poller.js";
import { resetHostCallFailureSuppression } from "../src/host-errors.js";

const baseUrl = "http://127.0.0.1:3100";

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function pollCtx() {
  return {
    state: { get: vi.fn(), set: vi.fn() },
    // Slack's own chat.postMessage goes through ctx.http.fetch, not the global fetch
    // stubbed per-test for the Paperclip REST API - default it to a successful post so
    // tests that exercise dispatch don't also have to mock the Slack leg individually.
    http: { fetch: vi.fn(async () => jsonResponse({ ok: true, ts: "123.456" })) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    activity: { log: vi.fn(async () => undefined) },
    metrics: { write: vi.fn(async () => undefined) },
  } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHostCallFailureSuppression();
});

describe("humanLoopEventForIssue", () => {
  it("creates a synthetic input-needed event for pending user decisions", () => {
    const event = humanLoopEventForIssue(
      { id: "company-1", name: "Product" },
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "PRO-1",
        title: "Pick launch option",
        status: "in_review",
        priority: "high",
        updatedAt: "2026-06-28T00:00:00.000Z",
        blockedInboxAttention: {
          state: "awaiting_decision",
          reason: "pending_user_decision",
          stoppedSinceAt: "2026-06-28T00:00:00.000Z",
          interactionId: "interaction-1",
          action: { label: "Answer question", detail: "Agent needs a launch choice." },
          owner: { type: "user", label: "Operator" },
        },
      },
      undefined,
      undefined,
      {
        id: "interaction-1",
        kind: "ask_user_questions",
        status: "pending",
        title: "Choose the launch path",
        summary: "Agent needs a launch choice.",
        payload: {
          version: 1,
          title: "Launch path",
          questions: [{
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
        },
      },
    );

    expect(event).toMatchObject({
      eventType: "plugin.paperclip-plugin-slack-bridge.human_input_needed",
      companyId: "company-1",
      entityId: "issue-1",
      payload: {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "ask_user_questions",
        interactionTitle: "Choose the launch path",
        interactionSummary: "Agent needs a launch choice.",
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
        actionLabel: "Answer question",
        reason: "pending_user_decision",
      },
    });
  });

  it("creates a synthetic confirmation event for pending request_confirmation interactions", () => {
    const event = humanLoopEventForIssue(
      { id: "company-1", name: "Product" },
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "PRO-3",
        title: "Confirm the plan",
        status: "blocked",
        updatedAt: "2026-06-28T00:00:00.000Z",
        blockedInboxAttention: {
          state: "awaiting_decision",
          reason: "pending_user_decision",
          stoppedSinceAt: "2026-06-28T00:00:00.000Z",
          interactionId: "interaction-confirm-1",
          action: { label: "Confirm plan", detail: "Agent needs plan confirmation." },
          owner: { type: "user", label: "Operator" },
        },
      },
      undefined,
      undefined,
      {
        id: "interaction-confirm-1",
        kind: "request_confirmation",
        status: "pending",
        title: "Confirm deployment plan",
        summary: "Agent needs a yes/no decision.",
        payload: {
          version: 1,
          prompt: "Should the agent apply this plan?",
          detailsMarkdown: "Plan touches only Slack notification copy.",
          acceptLabel: "Apply plan",
          rejectLabel: "Do not apply",
          rejectRequiresReason: false,
        },
      },
    );

    expect(event).toMatchObject({
      eventType: "plugin.paperclip-plugin-slack-bridge.human_input_needed",
      companyId: "company-1",
      entityId: "issue-1",
      payload: {
        issueId: "issue-1",
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
      },
    });
  });

  it("creates a synthetic checkbox-confirmation event for pending request_checkbox_confirmation interactions", () => {
    const event = humanLoopEventForIssue(
      { id: "company-1", name: "Product" },
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "PRO-4",
        title: "Confirm checklist",
        status: "blocked",
        updatedAt: "2026-06-28T00:00:00.000Z",
        blockedInboxAttention: {
          state: "awaiting_decision",
          reason: "pending_user_decision",
          stoppedSinceAt: "2026-06-28T00:00:00.000Z",
          interactionId: "interaction-check-1",
          action: { label: "Confirm checklist", detail: "Agent needs selected checks." },
          owner: { type: "user", label: "Operator" },
        },
      },
      undefined,
      undefined,
      {
        id: "interaction-check-1",
        kind: "request_checkbox_confirmation",
        status: "pending",
        title: "Confirm selected checks",
        summary: "Agent needs selected approvals.",
        payload: {
          version: 1,
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
          ],
        },
      },
    );

    expect(event).toMatchObject({
      eventType: "plugin.paperclip-plugin-slack-bridge.human_input_needed",
      companyId: "company-1",
      entityId: "issue-1",
      payload: {
        issueId: "issue-1",
        interactionId: "interaction-check-1",
        interactionKind: "request_checkbox_confirmation",
        interactionTitle: "Confirm selected checks",
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
          ],
        },
      },
    });
  });

  it("creates a synthetic suggest-tasks event for pending suggest_tasks interactions", () => {
    const event = humanLoopEventForIssue(
      { id: "company-1", name: "Product" },
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "PRO-5",
        title: "Review suggested tasks",
        status: "blocked",
        updatedAt: "2026-06-28T00:00:00.000Z",
        blockedInboxAttention: {
          state: "awaiting_decision",
          reason: "pending_user_decision",
          stoppedSinceAt: "2026-06-28T00:00:00.000Z",
          interactionId: "interaction-suggest-1",
          action: { label: "Review tasks", detail: "Agent suggested follow-up tasks." },
          owner: { type: "user", label: "Operator" },
        },
      },
      undefined,
      undefined,
      {
        id: "interaction-suggest-1",
        kind: "suggest_tasks",
        status: "pending",
        title: "Review follow-up tasks",
        summary: "Agent suggested next implementation work.",
        payload: {
          version: 1,
          tasks: [
            { clientKey: "root", title: "Create root follow-up", description: "Add the root issue first.", priority: "high", workMode: "planning" },
            { clientKey: "child", parentClientKey: "root", title: "Create nested follow-up" },
          ],
        },
      },
    );

    expect(event).toMatchObject({
      eventType: "plugin.paperclip-plugin-slack-bridge.human_input_needed",
      companyId: "company-1",
      entityId: "issue-1",
      payload: {
        issueId: "issue-1",
        interactionId: "interaction-suggest-1",
        interactionKind: "suggest_tasks",
        interactionTitle: "Review follow-up tasks",
        interactionSummary: "Agent suggested next implementation work.",
        interactionSuggestedTasks: {
          tasks: [
            { clientKey: "root", title: "Create root follow-up", description: "Add the root issue first.", priority: "high", workMode: "planning" },
            { clientKey: "child", parentClientKey: "root", title: "Create nested follow-up" },
          ],
        },
      },
    });
  });

  it("creates a synthetic approval event for pending board decisions", () => {
    const event = humanLoopEventForIssue(
      { id: "company-1", name: "Product" },
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "PRO-2",
        title: "Approve plan",
        updatedAt: "2026-06-28T00:00:00.000Z",
        blockedInboxAttention: {
          state: "awaiting_decision",
          reason: "pending_board_decision",
          stoppedSinceAt: "2026-06-28T00:00:00.000Z",
          approvalId: "approval-1",
          action: { label: "Decide approval", detail: "Approve, reject, or request revision." },
          owner: { type: "board", label: "Board" },
        },
      },
      {
        id: "approval-1",
        type: "request_board_approval",
        status: "pending",
        requestedByAgentId: "agent-ceo",
        requestedByAgentName: "CEO",
        updatedAt: "2026-06-28T00:01:00.000Z",
        payload: {
          title: "Ratify package id",
          summary: "Approve the final package id.",
          recommendedAction: "Approve com.ephemeralstudios.gstack.",
          risks: ["Package id is permanent."],
        },
      },
      [{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }],
    );

    expect(event).toMatchObject({
      eventType: "approval.created",
      companyId: "company-1",
      entityId: "approval-1",
      payload: {
        issueId: "issue-1",
        approvalId: "approval-1",
        actionLabel: "Decide approval",
        reason: "pending_board_decision",
        approvalTitle: "Board Approval: Ratify package id",
        summary: "Approve the final package id.",
        recommendedAction: "Approve com.ephemeralstudios.gstack.",
        risks: ["Package id is permanent."],
        requestedByName: "CEO",
        linkedIssues: [{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }],
      },
    });
  });

  it("enriches native approval.created events from the approval API", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/approvals/approval-1")) {
        return new Response(JSON.stringify({
          id: "approval-1",
          companyId: "company-1",
          type: "request_board_approval",
          status: "pending",
          requestedByUserId: "local-board",
          updatedAt: "2026-06-28T00:01:00.000Z",
          payload: {
            title: "Ratify package id",
            summary: "Approve the final package id.",
            recommendedAction: "Approve com.ephemeralstudios.gstack.",
            risks: ["Package id is permanent."],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/approvals/approval-1/issues")) {
        return new Response(JSON.stringify([{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const event = await approvalCreatedEventFromApi(
      { logger: { warn: vi.fn() } } as any,
      { defaultChannelId: "C0", paperclipBaseUrl: "http://127.0.0.1:3100" },
      {
        eventId: "raw-approval-event",
        eventType: "approval.created",
        occurredAt: "2026-06-28T00:00:00.000Z",
        actorId: "local-board",
        actorType: "user",
        entityId: "approval-1",
        entityType: "approval",
        companyId: "company-1",
        payload: { type: "request_board_approval", issueIds: ["issue-1"] },
      } as any,
    );

    expect(event).toMatchObject({
      eventId: "hitl:v2:approval:company-1:approval-1:2026-06-28T00:01:00.000Z",
      eventType: "approval.created",
      entityId: "approval-1",
      payload: {
        approvalId: "approval-1",
        approvalTitle: "Board Approval: Ratify package id",
        summary: "Approve the final package id.",
        recommendedAction: "Approve com.ephemeralstudios.gstack.",
        risks: ["Package id is permanent."],
        linkedIssues: [{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }],
        companyPrefix: "PRO",
      },
    });
    vi.unstubAllGlobals();
  });
});

function approvalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    requestedByUserId: "local-board",
    updatedAt: "2026-06-28T00:01:00.000Z",
    payload: {
      title: "Ratify package id",
      summary: "Approve the final package id.",
      recommendedAction: "Approve com.ephemeralstudios.gstack.",
      risks: ["Package id is permanent."],
    },
    ...overrides,
  };
}

describe("pollHumanLoopAttention", () => {
  it("does not write per-company scan activity entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) return jsonResponse([]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) return jsonResponse([]);
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({ scannedCompanies: 1, scannedIssues: 0, dispatched: 0, failedCompanies: 0, pendingApprovalsSeen: 0, pendingApprovalsRecovered: 0 });
    expect(ctx.activity.log).not.toHaveBeenCalled();
  });

  it("does not write per-company failure activity entries while preserving failure attribution", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) {
        return jsonResponse({ error: "drift" }, { status: 500, statusText: "Internal Server Error" });
      }
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) return jsonResponse([]);
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({
      scannedCompanies: 1,
      scannedIssues: 0,
      dispatched: 0,
      failedCompanies: 1,
      failureSource: "rest-fetch",
      errorKind: "unknown",
    });
    expect(ctx.activity.log).not.toHaveBeenCalled();
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "poller",
      method: "issues.list",
      error_kind: "unknown",
    }));
  });

  // Each test below gives its approval(s) a unique id/updatedAt. dispatchPaperclipEvent's
  // dedupe falls through to an in-process memorySeenEvents Map keyed on companyId+eventId
  // (notification-dispatcher.ts) that this suite has no reset hook for, so a reused
  // approvalId+updatedAt pair would read as a duplicate of an earlier test's dispatch and
  // silently fail to post here.
  it("recovers a pending approval linked to a done issue, invisible to the issue-attention scan (STO-268 / #24, mode 1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      // The issue-attention scan's own query filters to attention=blocked, so a `done`
      // issue's approval never shows up here - the scan sees nothing at all.
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) return jsonResponse([]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) {
        return jsonResponse([approvalFixture({ id: "approval-mode1", updatedAt: "2026-08-01T00:00:00.000Z" })]);
      }
      if (url.endsWith("/api/approvals/approval-mode1/issues")) {
        return jsonResponse([{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({ dispatched: 1, pendingApprovalsSeen: 1, pendingApprovalsRecovered: 1 });
  });

  it("recovers a second pending approval sharing an issue with one already surfaced by the attention scan (STO-268 / #24, mode 3)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) {
        return jsonResponse([{
          id: "issue-1",
          companyId: "company-1",
          identifier: "PRO-2",
          title: "Approve plan",
          updatedAt: "2026-06-28T00:00:00.000Z",
          // blockedInboxAttention is a single slot: it can only ever name ONE of the two
          // approvals filed against this issue. approval-1 is visible here; approval-2 is not.
          blockedInboxAttention: {
            state: "awaiting_decision",
            reason: "pending_board_decision",
            stoppedSinceAt: "2026-06-28T00:00:00.000Z",
            approvalId: "approval-mode3a",
            action: { label: "Decide approval", detail: "Approve, reject, or request revision." },
            owner: { type: "board", label: "Board" },
          },
        }]);
      }
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) {
        return jsonResponse([
          approvalFixture({ id: "approval-mode3a", updatedAt: "2026-08-01T00:01:00.000Z" }),
          approvalFixture({ id: "approval-mode3b", updatedAt: "2026-08-01T00:02:00.000Z" }),
        ]);
      }
      if (url.endsWith("/api/approvals/approval-mode3a")) {
        return jsonResponse(approvalFixture({ id: "approval-mode3a", updatedAt: "2026-08-01T00:01:00.000Z" }));
      }
      if (url.endsWith("/api/approvals/approval-mode3a/issues") || url.endsWith("/api/approvals/approval-mode3b/issues")) {
        return jsonResponse([{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    // Both approvals dispatched: approval-mode3a via the issue-attention slot,
    // approval-mode3b via the pending-approvals recovery pass. Only approval-mode3b counts
    // as "recovered" - approval-mode3a was never invisible.
    expect(result).toMatchObject({ dispatched: 2, pendingApprovalsSeen: 2, pendingApprovalsRecovered: 1 });
  });

  it("recovers a pending approval whose issue's attention slot is claimed by an unrelated reason (STO-268 / #24, mode 2)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) {
        return jsonResponse([{
          id: "issue-1",
          companyId: "company-1",
          identifier: "PRO-2",
          title: "Approve plan",
          updatedAt: "2026-06-28T00:00:00.000Z",
          // A higher-priority attention branch (a run-disposition handoff) has claimed
          // the issue's one attention slot, so the pending-board-decision approval never
          // surfaces via blockedInboxAttention at all.
          blockedInboxAttention: {
            state: "awaiting_decision",
            reason: "missing_disposition",
            stoppedSinceAt: "2026-06-28T00:00:00.000Z",
          },
        }]);
      }
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) {
        return jsonResponse([approvalFixture({ id: "approval-mode2", updatedAt: "2026-08-01T00:03:00.000Z" })]);
      }
      if (url.endsWith("/api/approvals/approval-mode2/issues")) {
        return jsonResponse([{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({ dispatched: 1, pendingApprovalsSeen: 1, pendingApprovalsRecovered: 1 });
  });

  it("does not re-dispatch or double-count an approval already surfaced by the issue-attention scan", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) {
        return jsonResponse([{
          id: "issue-1",
          companyId: "company-1",
          identifier: "PRO-2",
          title: "Approve plan",
          updatedAt: "2026-06-28T00:00:00.000Z",
          blockedInboxAttention: {
            state: "awaiting_decision",
            reason: "pending_board_decision",
            stoppedSinceAt: "2026-06-28T00:00:00.000Z",
            approvalId: "approval-dedup",
            action: { label: "Decide approval", detail: "Approve, reject, or request revision." },
            owner: { type: "board", label: "Board" },
          },
        }]);
      }
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) {
        return jsonResponse([approvalFixture({ id: "approval-dedup", updatedAt: "2026-08-01T00:04:00.000Z" })]);
      }
      if (url.endsWith("/api/approvals/approval-dedup")) {
        return jsonResponse(approvalFixture({ id: "approval-dedup", updatedAt: "2026-08-01T00:04:00.000Z" }));
      }
      if (url.endsWith("/api/approvals/approval-dedup/issues")) {
        return jsonResponse([{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({ dispatched: 1, pendingApprovalsSeen: 1, pendingApprovalsRecovered: 0 });
  });

  it("still runs the pending-approvals recovery pass when the issue-attention scan itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) {
        return jsonResponse({ error: "drift" }, { status: 500, statusText: "Internal Server Error" });
      }
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) {
        return jsonResponse([approvalFixture({ id: "approval-issuesfail", updatedAt: "2026-08-01T00:05:00.000Z" })]);
      }
      if (url.endsWith("/api/approvals/approval-issuesfail/issues")) {
        return jsonResponse([{ id: "issue-1", identifier: "PRO-2", title: "Approve plan" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({ failedCompanies: 1, dispatched: 1, pendingApprovalsSeen: 1, pendingApprovalsRecovered: 1 });
  });

  it("logs and continues, without throwing, when the pending-approvals endpoint itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${baseUrl}/api/companies`) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/issues?`)) return jsonResponse([]);
      if (url.startsWith(`${baseUrl}/api/companies/company-1/approvals?`)) {
        return jsonResponse({ error: "drift" }, { status: 500, statusText: "Internal Server Error" });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const ctx = pollCtx();

    const result = await pollHumanLoopAttention(ctx, { botToken: "xoxb-test" }, { defaultChannelId: "C0", paperclipBaseUrl: baseUrl });

    expect(result).toMatchObject({ scannedCompanies: 1, dispatched: 0, pendingApprovalsSeen: 0, pendingApprovalsRecovered: 0 });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "poller",
      method: "approvals.list",
    }));
  });
});

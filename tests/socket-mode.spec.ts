import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_IDS } from "../src/constants.js";
import { resetHostCallFailureSuppression } from "../src/host-errors.js";
import type { SlackNotificationsConfig } from "../src/types.js";

const socketMock = vi.hoisted(() => ({
  instances: [] as Array<{ handlers: Map<string, (envelope: unknown) => Promise<void>> }>,
}));

const slackApiMock = vi.hoisted(() => ({
  calls: [] as string[],
  postMessage: vi.fn(async () => {
    slackApiMock.calls.push("postMessage");
    return { ok: true };
  }),
  respondToInteraction: vi.fn(async () => {
    slackApiMock.calls.push("respondToInteraction");
    return { ok: true };
  }),
}));

vi.mock("@slack/socket-mode", () => {
  class SocketModeClient {
    handlers = new Map<string, (envelope: unknown) => Promise<void>>();

    constructor() {
      socketMock.instances.push(this);
    }

    on(eventName: string, handler: (envelope: unknown) => Promise<void>) {
      this.handlers.set(eventName, handler);
      return this;
    }

    async start() {}
    async disconnect() {}
  }

  return { LogLevel: { WARN: "WARN" }, SocketModeClient };
});

vi.mock("../src/slack-api.js", () => slackApiMock);

const config: SlackNotificationsConfig = {
  slackBotToken: "xoxb-redacted",
  slackAppToken: "xapp-redacted",
  defaultChannelId: "C0000000000",
};

const scopeDenied = new Error('Plugin "plugin-1" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope');
const capabilityDenied = new Error('Plugin "plugin-1" is missing required capability "issues.wakeup" for method "issues.requestWakeup"');

describe("Slack Socket Mode ingress", () => {
  beforeEach(() => {
    resetHostCallFailureSuppression();
    socketMock.instances.length = 0;
    slackApiMock.calls.length = 0;
    slackApiMock.postMessage.mockClear();
    slackApiMock.respondToInteraction.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it("registers and immediately acks slash command envelopes", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");

    const client = socketMock.instances[0];
    expect(client.handlers.has("slash_commands")).toBe(true);
    expect(client.handlers.has("slack_event")).toBe(true);
    expect(client.handlers.has("interactive")).toBe(true);

    const calls: string[] = [];
    const ack = vi.fn(async () => {
      calls.push("ack");
    });
    slackApiMock.postMessage.mockImplementationOnce(async () => {
      calls.push("postMessage");
      return { ok: true };
    });

    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack,
      body: { type: "slash_commands", text: "status", channel_id: "C0000000000" },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(slackApiMock.postMessage).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["ack", "postMessage"]);
  });

  it("posts approval button actions to Paperclip and replaces the Slack card with read-only state", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      const route = url.endsWith("/approve") ? "approved"
        : url.endsWith("/reject") ? "rejected"
          : url.endsWith("/request-revision") ? "revision_requested"
            : "approved";
      return new Response(JSON.stringify({
        id: "approval-1",
        companyId: "company-1",
        type: "request_board_approval",
        status: route,
        decisionNote: `Resolved as ${route}`,
        updatedAt: "2026-06-28T00:00:00.000Z",
        payload: {
          title: "Board Approval: Ratify package id",
          summary: "This approval asks the board to ratify the final package id.",
          companyPrefix: "COM",
        },
      }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];

    const cases = [
      [ACTION_IDS.approvalApprove, "approve", "Approval approved"],
      [ACTION_IDS.approvalDeny, "reject", "Approval rejected"],
      [ACTION_IDS.approvalRequestRevision, "request-revision", "Revision requested"],
    ] as const;

    for (const [index, [actionId, route, label]] of cases.entries()) {
      const ack = vi.fn(async () => undefined);
      await client.handlers.get("block_actions")?.({
        type: "block_actions",
        ack,
        body: {
          type: "block_actions",
          response_url: "https://slack.example/response",
          actions: [{ action_id: actionId, value: JSON.stringify({ approvalId: "approval-1", companyPrefix: "COM" }) }],
        },
      });

      expect(ack).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:3100/api/approvals/approval-1/${route}`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(index + 1);
      const call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
      expect(call?.[1]).toBe("https://slack.example/response");
      expect(call?.[3]).toEqual(expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }));
      const rendered = JSON.stringify(call?.[2]);
      expect(rendered).toContain(label);
      expect(rendered).toContain("Board Approval: Ratify package id");
      expect(rendered).toContain("Open in Paperclip");
      expect(rendered).not.toContain(ACTION_IDS.approvalApprove);
      expect(rendered).not.toContain(ACTION_IDS.approvalDeny);
      expect(rendered).not.toContain(ACTION_IDS.approvalRequestRevision);
    }
  });

  it("replaces stale approval cards with current Paperclip state after conflicting actions", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/reject") && init && (init as RequestInit).method === "POST") {
        return new Response(JSON.stringify({ error: "Only pending approvals can be rejected" }), { status: 422 });
      }
      if (url.endsWith("/api/approvals/approval-1")) {
        return new Response(JSON.stringify({
          id: "approval-1",
          companyId: "company-1",
          type: "request_board_approval",
          status: "approved",
          decisionNote: "Already approved from Slack.",
          updatedAt: "2026-06-28T00:00:00.000Z",
          payload: {
            title: "Board Approval: Ratify package id",
            summary: "The board already approved this request.",
            companyPrefix: "COM",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-stale-approval-1",
        user: { id: "U1" },
        container: { message_ts: "423.456" },
        actions: [{ action_id: ACTION_IDS.approvalDeny, action_ts: "423.457", value: JSON.stringify({ approvalId: "approval-1", companyPrefix: "COM" }) }],
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/approvals/approval-1/reject",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/approvals/approval-1",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: "Approval approved: Board Approval: Ratify package id" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
    const rendered = JSON.stringify((slackApiMock.respondToInteraction.mock.calls as unknown[][])[0][2]);
    expect(rendered).toContain("Already approved from Slack.");
    expect(rendered).not.toContain("Approval rejected failed");
  });

  it("posts request-confirmation actions to Paperclip and replaces the Slack card", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      const status = url.endsWith("/accept") ? "accepted" : "rejected";
      return new Response(JSON.stringify({
        id: "interaction-confirm-1",
        issueId: "issue-1",
        kind: "request_confirmation",
        status,
        title: "Confirm deployment plan",
        result: {
          version: 1,
          outcome: status,
          ...(status === "rejected" ? { reason: "Rejected from Slack." } : {}),
        },
      }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const cases = [
      [ACTION_IDS.interactionAccept, "accept", "Confirmation accepted"],
      [ACTION_IDS.interactionReject, "reject", "Confirmation rejected"],
    ] as const;

    for (const [index, [actionId, route, label]] of cases.entries()) {
      await client.handlers.get("block_actions")?.({
        type: "block_actions",
        ack: vi.fn(async () => undefined),
        body: {
          type: "block_actions",
          response_url: "https://slack.example/response",
          trigger_id: `trigger-confirm-${index}`,
          user: { id: "U1" },
          container: { message_ts: `523.${index}` },
          actions: [{
            action_id: actionId,
            action_ts: `523.${index + 1}`,
            value: JSON.stringify({ issueId: "issue-1", interactionId: "interaction-confirm-1", companyPrefix: "COM", kind: "request_confirmation" }),
          }],
        },
      });

      expect(fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-confirm-1/${route}`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(index + 1);
      const call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
      expect(call?.[3]).toEqual(expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }));
      const rendered = JSON.stringify(call?.[2]);
      expect(rendered).toContain(label);
      expect(rendered).toContain("Confirm deployment plan");
      expect(rendered).toContain("Open Issue");
      expect(rendered).not.toContain(ACTION_IDS.interactionAccept);
      expect(rendered).not.toContain(ACTION_IDS.interactionReject);
    }
  });

  it("posts request-checkbox-confirmation selected options to Paperclip and replaces the Slack card", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      expect(url.endsWith("/accept")).toBe(true);
      return new Response(JSON.stringify({
        id: "interaction-check-1",
        issueId: "issue-1",
        kind: "request_checkbox_confirmation",
        status: "accepted",
        title: "Confirm selected checks",
        result: {
          version: 1,
          outcome: "accepted",
          selectedOptionIds: ["docs", "tests"],
        },
      }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-checkbox-confirm-1",
        user: { id: "U1" },
        container: { message_ts: "533.456" },
        actions: [{
          action_id: ACTION_IDS.interactionAccept,
          action_ts: "533.457",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-check-1",
            companyPrefix: "COM",
            kind: "request_checkbox_confirmation",
            optionActionId: ACTION_IDS.interactionCheckboxSelect,
            minSelected: 1,
            maxSelected: 2,
            defaultSelectedOptionIds: ["docs"],
          }),
        }],
        state: {
          values: {
            pc_interaction_checkbox_confirmation: {
              [ACTION_IDS.interactionCheckboxSelect]: {
                type: "checkboxes",
                selected_options: [
                  { text: { type: "plain_text", text: "Docs are updated" }, value: "docs" },
                  { text: { type: "plain_text", text: "Tests are green" }, value: "tests" },
                ],
              },
            },
          },
        },
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-check-1/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ selectedOptionIds: ["docs", "tests"] }),
      }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: "Confirm selected checks: Confirmation accepted" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
  });

  it("asks for required checkbox selections before accepting checkbox confirmations", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-checkbox-confirm-missing",
        user: { id: "U1" },
        container: { message_ts: "534.456" },
        actions: [{
          action_id: ACTION_IDS.interactionAccept,
          action_ts: "534.457",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-check-1",
            companyPrefix: "COM",
            kind: "request_checkbox_confirmation",
            optionActionId: ACTION_IDS.interactionCheckboxSelect,
            minSelected: 1,
            maxSelected: 2,
            defaultSelectedOptionIds: [],
          }),
        }],
        state: { values: {} },
      },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: expect.stringContaining("Selection needed") }),
      expect.objectContaining({ responseType: "ephemeral" }),
    );
  });

  it("posts selected suggested task client keys to Paperclip and replaces the Slack card", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      expect(url.endsWith("/accept")).toBe(true);
      return new Response(JSON.stringify({
        id: "interaction-suggest-1",
        issueId: "issue-1",
        kind: "suggest_tasks",
        status: "accepted",
        title: "Review follow-up tasks",
        result: {
          version: 1,
          createdTasks: [
            { clientKey: "root", identifier: "COM-10", title: "Create root follow-up" },
            { clientKey: "child", identifier: "COM-11", title: "Create nested follow-up" },
          ],
        },
      }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-suggest-tasks-1",
        user: { id: "U1" },
        container: { message_ts: "543.456" },
        actions: [{
          action_id: ACTION_IDS.interactionAccept,
          action_ts: "543.457",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-suggest-1",
            companyPrefix: "COM",
            kind: "suggest_tasks",
            optionActionId: ACTION_IDS.suggestedTasksSelect,
            taskClientKeys: ["root", "child"],
            taskParentClientKeys: { child: "root" },
          }),
        }],
        state: {
          values: {
            pc_interaction_suggested_tasks: {
              [ACTION_IDS.suggestedTasksSelect]: {
                type: "checkboxes",
                selected_options: [
                  { text: { type: "plain_text", text: "Create root follow-up" }, value: "root" },
                  { text: { type: "plain_text", text: "Create nested follow-up" }, value: "child" },
                ],
              },
            },
          },
        },
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-suggest-1/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ selectedClientKeys: ["root", "child"] }),
      }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: "Review follow-up tasks: Suggested tasks created" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
    const rendered = JSON.stringify((slackApiMock.respondToInteraction.mock.calls as unknown[][])[0][2]);
    expect(rendered).toContain("COM-10");
    expect(rendered).toContain("Create nested follow-up");
  });

  it("asks for parent suggested tasks before accepting child-only selections", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-suggest-tasks-parent",
        user: { id: "U1" },
        container: { message_ts: "544.456" },
        actions: [{
          action_id: ACTION_IDS.interactionAccept,
          action_ts: "544.457",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-suggest-1",
            companyPrefix: "COM",
            kind: "suggest_tasks",
            optionActionId: ACTION_IDS.suggestedTasksSelect,
            taskClientKeys: ["root", "child"],
            taskParentClientKeys: { child: "root" },
          }),
        }],
        state: {
          values: {
            pc_interaction_suggested_tasks: {
              [ACTION_IDS.suggestedTasksSelect]: {
                type: "checkboxes",
                selected_options: [
                  { text: { type: "plain_text", text: "Create nested follow-up" }, value: "child" },
                ],
              },
            },
          },
        },
      },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: expect.stringContaining("Parent task needed") }),
      expect.objectContaining({ responseType: "ephemeral" }),
    );
  });

  it("replaces stale request-confirmation cards with current interaction state", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/reject") && init && (init as RequestInit).method === "POST") {
        return new Response(JSON.stringify({ error: "Interaction has already been resolved" }), { status: 409 });
      }
      if (url.endsWith("/api/issues/issue-1/interactions")) {
        return new Response(JSON.stringify([{
          id: "interaction-confirm-1",
          issueId: "issue-1",
          kind: "request_confirmation",
          status: "accepted",
          title: "Confirm deployment plan",
          result: { version: 1, outcome: "accepted" },
        }]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-stale-confirm-1",
        user: { id: "U1" },
        container: { message_ts: "623.456" },
        actions: [{
          action_id: ACTION_IDS.interactionReject,
          action_ts: "623.457",
          value: JSON.stringify({ issueId: "issue-1", interactionId: "interaction-confirm-1", companyPrefix: "COM", kind: "request_confirmation" }),
        }],
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-confirm-1/reject",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: "Confirm deployment plan: Confirmation accepted" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
  });

  it("keeps Open in Paperclip URL button interactions quiet", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const ack = vi.fn(async () => undefined);
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack,
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-open-1",
        user: { id: "U1" },
        container: { message_ts: "123.456" },
        actions: [{ action_id: ACTION_IDS.approvalOpen, value: JSON.stringify({ approvalId: "approval-1", companyPrefix: "COM" }), action_ts: "123.457" }],
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(slackApiMock.respondToInteraction).not.toHaveBeenCalled();
  });

  it("posts inline ask-user-question form state to the Paperclip interaction respond API", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const ack = vi.fn(async () => undefined);
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack,
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-submit-1",
        user: { id: "U1" },
        container: { message_ts: "223.456" },
        actions: [{
          action_id: ACTION_IDS.interactionSubmit,
          action_ts: "223.458",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-1",
            companyPrefix: "COM",
            questions: [{
              id: "next_step",
              selectionMode: "single",
              required: true,
              optionActionId: `${ACTION_IDS.interactionOptionSelect}.1`,
              otherActionId: `${ACTION_IDS.interactionOtherText}.1`,
            }],
          }),
        }],
        state: {
          values: {
            pc_interaction_option_1: {
              [`${ACTION_IDS.interactionOptionSelect}.1`]: {
                type: "radio_buttons",
                selected_option: { text: { type: "plain_text", text: "Proceed with approval path" }, value: "approve_path" },
              },
            },
            pc_interaction_other_1: {
              [`${ACTION_IDS.interactionOtherText}.1`]: {
                type: "plain_text_input",
                value: "Also include the Slack message inline Other answer.",
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-1/respond",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          answers: [{
            questionId: "next_step",
            optionIds: ["approve_path"],
            otherText: "Also include the Slack message inline Other answer.",
          }],
          summaryMarkdown: "Answered from Slack:\n- next_step: approve_path — Also include the Slack message inline Other answer.",
        }),
      }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(1);
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: "Question answered: answered" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
    expect(JSON.stringify((slackApiMock.respondToInteraction.mock.calls as unknown[][])[0][2])).toContain("Submitted summary");
  });

  it("replaces stale interaction forms with the resolved Paperclip answer on duplicate submit", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/respond")) return new Response(JSON.stringify({ error: "already answered" }), { status: 409 });
      if (url.endsWith("/interactions")) {
        return new Response(JSON.stringify([{
          id: "interaction-1",
          status: "answered",
          title: "Inline Slack Other proof",
          result: {
            summaryMarkdown: "Answered from Slack:\n- next_step: Other — prior answer",
          },
        }]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-submit-409",
        user: { id: "U1" },
        container: { message_ts: "323.456" },
        actions: [{
          action_id: ACTION_IDS.interactionSubmit,
          action_ts: "323.458",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-1",
            companyPrefix: "COM",
            questions: [{
              id: "next_step",
              selectionMode: "single",
              required: true,
              optionActionId: `${ACTION_IDS.interactionOptionSelect}.1`,
              otherActionId: `${ACTION_IDS.interactionOtherText}.1`,
            }],
          }),
        }],
        state: {
          values: {
            pc_interaction_option_1: {
              [`${ACTION_IDS.interactionOptionSelect}.1`]: {
                type: "radio_buttons",
                selected_option: { text: { type: "plain_text", text: "Inline radio + Other textarea" }, value: "inline_other" },
              },
            },
          },
        },
      },
    });

    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: "Inline Slack Other proof: answered" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
    expect(JSON.stringify((slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1)?.[2])).toContain("prior answer");
  });

  it("posts ask-user-question option buttons to the Paperclip interaction respond API", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const ack = vi.fn(async () => undefined);
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack,
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-answer-1",
        user: { id: "U1" },
        container: { message_ts: "123.456" },
        actions: [{
          action_id: `${ACTION_IDS.interactionAnswerOption}.1`,
          action_ts: "123.458",
          value: JSON.stringify({
            issueId: "issue-1",
            interactionId: "interaction-1",
            questionId: "next_step",
            optionId: "approve_path",
            optionLabel: "Proceed with approval path",
            companyPrefix: "COM",
          }),
        }],
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-1/respond",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          answers: [{ questionId: "next_step", optionIds: ["approve_path"] }],
          summaryMarkdown: "Answered from Slack: Proceed with approval path",
        }),
      }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((slackApiMock.respondToInteraction.mock.calls as unknown[][])[0][2])).toContain("Answer sent");
  });

  it("dedupes repeated Slack action envelopes", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const envelope = {
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-approve-1",
        user: { id: "U1" },
        container: { message_ts: "123.456" },
        actions: [{ action_id: ACTION_IDS.approvalApprove, value: JSON.stringify({ approvalId: "approval-1", companyPrefix: "COM" }), action_ts: "123.457" }],
      },
    };

    await client.handlers.get("block_actions")?.(envelope);
    await client.handlers.get("interactive")?.(envelope);

    expect(envelope.ack).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(1);
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "https://slack.example/response",
      expect.objectContaining({ text: expect.stringContaining("Approval approved") }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
  });

  it("creates a Paperclip issue from /paperclip create", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      id: "issue-9",
      identifier: "PRO-9",
      title: String(input.title),
    }));
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => [{ id: "company-1", name: "Proto", issuePrefix: "PRO" }]) },
      issues: { list: vi.fn(async () => []), create },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];

    const respond = vi.fn(async () => ({ ok: true }));
    slackApiMock.respondToInteraction.mockImplementationOnce(respond);
    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack: vi.fn(async () => undefined),
      body: { type: "slash_commands", text: "create PRO Ship the bridge", channel_id: "C0000000000", response_url: "https://hooks.slack.test/respond" },
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      title: "Ship the bridge",
      originKind: expect.stringContaining("paperclip-plugin-slack-bridge"),
    }));
    const message = JSON.stringify(respond.mock.calls[0]);
    expect(message).toContain("Issue created");
    expect(message).toContain("PRO-9");
  });

  it("classifies scope-denied status enrichment and records a host-call metric", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => { throw scopeDenied; }) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const respond = vi.fn(async () => ({ ok: true }));
    slackApiMock.respondToInteraction.mockImplementationOnce(respond);

    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack: vi.fn(async () => undefined),
      body: { type: "slash_commands", text: "status", channel_id: "C0000000000", response_url: "https://hooks.slack.test/respond" },
    });

    const message = JSON.stringify(respond.mock.calls[0]);
    expect(message).toContain("invocation-scope restriction in core");
    expect(message).not.toContain("Runtime summary unavailable");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "slash_command",
      method: "companies.list",
      error_kind: "scope-denied",
    }));
  });

  it("responds to /paperclip issues when company lookup is scope-denied", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => { throw scopeDenied; }) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const respond = vi.fn(async () => ({ ok: true }));
    slackApiMock.respondToInteraction.mockImplementationOnce(respond);

    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack: vi.fn(async () => undefined),
      body: { type: "slash_commands", text: "issues PRO", channel_id: "C0000000000", response_url: "https://hooks.slack.test/respond" },
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(respond.mock.calls[0])).toContain("invocation-scope restriction in core");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "slash_command",
      method: "companies.list",
      error_kind: "scope-denied",
    }));
  });

  it("classifies create and wakeup host denials in Slack responses and metrics", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const create = vi.fn(async () => { throw scopeDenied; });
    const requestWakeup = vi.fn(async () => { throw capabilityDenied; });
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => [{ id: "company-1", name: "Proto", issuePrefix: "PRO" }]) },
      issues: {
        list: vi.fn(async () => [{ id: "issue-1", identifier: "PRO-1", title: "Fix the poller" }]),
        create,
        requestWakeup,
      },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];
    const respond = vi.fn(async () => ({ ok: true }));
    slackApiMock.respondToInteraction.mockImplementation(respond);

    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack: vi.fn(async () => undefined),
      body: { type: "slash_commands", text: "create PRO Ship the bridge", channel_id: "C0000000000", response_url: "https://hooks.slack.test/respond" },
    });
    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack: vi.fn(async () => undefined),
      body: { type: "slash_commands", text: "wakeup PRO-1", channel_id: "C0000000000", response_url: "https://hooks.slack.test/respond" },
    });

    const rendered = JSON.stringify(respond.mock.calls);
    expect(rendered).toContain("invocation-scope restriction in core");
    expect(rendered).toContain("missing a required gated capability");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "slash_command",
      method: "issues.create",
      error_kind: "scope-denied",
    }));
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, expect.objectContaining({
      surface: "slash_command",
      method: "issues.requestWakeup",
      error_kind: "capability-denied",
    }));
  });

  it("queues an issue wakeup from /paperclip wakeup", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const requestWakeup = vi.fn(async () => ({ queued: true, runId: "run-9" }));
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => [{ id: "company-1", name: "Proto", issuePrefix: "PRO" }]) },
      issues: {
        list: vi.fn(async () => [{ id: "issue-1", identifier: "PRO-1", title: "Fix the poller" }]),
        requestWakeup,
      },
    } as any;

    await startSlackSocketMode(ctx, config, "xoxb-redacted", "xapp-redacted");
    const client = socketMock.instances[0];

    const respond = vi.fn(async () => ({ ok: true }));
    slackApiMock.respondToInteraction.mockImplementationOnce(respond);
    await client.handlers.get("slash_commands")?.({
      type: "slash_commands",
      ack: vi.fn(async () => undefined),
      body: { type: "slash_commands", text: "wakeup PRO-1", channel_id: "C0000000000", response_url: "https://hooks.slack.test/respond" },
    });

    expect(requestWakeup).toHaveBeenCalledWith("issue-1", "company-1", expect.objectContaining({
      idempotencyKey: expect.stringContaining("slack-wakeup:issue-1"),
    }));
    const message = JSON.stringify(respond.mock.calls[0]);
    expect(message).toContain("Queued run run-9");
  });
});

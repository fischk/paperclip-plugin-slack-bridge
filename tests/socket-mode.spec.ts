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
  slackBotToken: "test-bot-token",
  slackAppToken: "test-app-token",
  defaultChannelId: "C0000000000",
};

const scopeDenied = new Error('Plugin "plugin-1" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope');
const capabilityDenied = new Error('Plugin "plugin-1" is missing required capability "issues.wakeup" for method "issues.requestWakeup"');

function collectButtons(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectButtons);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record.type === "button" ? [record] : [];
  return own.concat(Object.values(record).flatMap(collectButtons));
}

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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");

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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];

    const cases = [
      [ACTION_IDS.approvalApprove, "approve", "✅ Approved"],
      [ACTION_IDS.approvalDeny, "reject", "↩️ Rejected"],
      [ACTION_IDS.approvalRequestRevision, "request-revision", "↩️ Revision requested"],
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
      expect(rendered).toContain("View in Paperclip");
      expect(rendered).not.toContain("Resolved as");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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
      expect.objectContaining({ text: "✅ Approved: Board Approval: Ratify package id" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
    const rendered = JSON.stringify((slackApiMock.respondToInteraction.mock.calls as unknown[][])[0][2]);
    expect(rendered).toContain("View in Paperclip");
    expect(rendered).not.toContain("Already approved from Slack.");
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
          ...(status === "rejected" ? { reason: "Needs safer rollout." } : {}),
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];
    const cases = [
      [ACTION_IDS.interactionAccept, "accept", "✅ Approved", undefined],
      [ACTION_IDS.interactionReject, "reject", "↩️ Sent back", "Needs safer rollout."],
    ] as const;

    for (const [index, [actionId, route, label, rejectReason]] of cases.entries()) {
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
            value: JSON.stringify({ issueId: "issue-1", interactionId: "interaction-confirm-1", companyPrefix: "COM", kind: "request_confirmation", rejectRequiresReason: actionId === ACTION_IDS.interactionReject }),
          }],
          ...(rejectReason ? {
            state: {
              values: {
                pc_interaction_reject_reason: {
                  [ACTION_IDS.interactionRejectReason]: {
                    type: "plain_text_input",
                    value: rejectReason,
                  },
                },
              },
            },
          } : {}),
        },
      });

      expect(fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-confirm-1/${route}`,
        expect.objectContaining({
          method: "POST",
          ...(route === "reject" ? { body: JSON.stringify({ reason: rejectReason }) } : {}),
        }),
      );
      expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(index + 1);
      const call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
      expect(call?.[3]).toEqual(expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }));
      const rendered = JSON.stringify(call?.[2]);
      expect(rendered).toContain(label);
      expect(rendered).toContain("Confirm deployment plan");
      expect(rendered).toContain("View in Paperclip");
      expect(rendered).not.toContain("Needs safer rollout.");
      expect(rendered).not.toContain("Open Issue");
      expect(rendered).not.toContain(ACTION_IDS.interactionAccept);
      expect(rendered).not.toContain(ACTION_IDS.interactionReject);
    }
  });

  it("opens and cancels the two-stage decline notes state without calling Paperclip", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];
    const { renderNotification } = await import("../src/block-kit/index.js");
    const initialCard = renderNotification({
      kind: "human.input_needed",
      eventId: "evt-confirm",
      eventType: "human.input_needed",
      occurredAt: "2026-06-27T00:00:00.000Z",
      companyId: "company-1",
      companyPrefix: "COM",
      entityId: "issue-1",
      issueId: "issue-1",
      identifier: "COM-1",
      title: "Human input needed for deployment",
      interactionId: "interaction-confirm-1",
      interactionKind: "request_confirmation",
      interactionTitle: "Confirm deployment plan",
      interactionConfirmation: {
        prompt: "Should the agent deploy?",
        acceptLabel: "Ship amber label proof",
        rejectLabel: "Return violet label proof",
        rejectRequiresReason: true,
      },
      raw: {},
    } as any, { ...config, paperclipBaseUrl: "http://127.0.0.1:3100" });
    const rejectStartButton = collectButtons(initialCard).find((button) => button.action_id === ACTION_IDS.interactionRejectStart);
    expect(rejectStartButton).toBeTruthy();
    const value = String(rejectStartButton?.value);
    expect(JSON.parse(value)).toEqual(expect.objectContaining({
      issueId: "issue-1",
      interactionId: "interaction-confirm-1",
      kind: "request_confirmation",
      rejectRequiresReason: true,
      acceptLabel: "Ship amber label proof",
      rejectLabel: "Return violet label proof",
      title: "Confirm deployment plan",
      prompt: "Should the agent deploy?",
    }));

    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-confirm-reject-start",
        user: { id: "U1" },
        container: { message_ts: "524.456" },
        actions: [{ action_id: ACTION_IDS.interactionRejectStart, action_ts: "524.457", value }],
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    let call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    expect(call?.[3]).toEqual(expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }));
    let rendered = JSON.stringify(call?.[2]);
    expect(rendered).toContain("Send back with notes");
    expect(rendered).toContain("Decline notes");
    expect(rendered).toContain("Return violet label proof");
    expect(rendered).toContain(ACTION_IDS.interactionReject);
    expect(rendered).toContain(ACTION_IDS.interactionRejectCancel);

    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-confirm-reject-cancel",
        user: { id: "U1" },
        container: { message_ts: "524.789" },
        actions: [{ action_id: ACTION_IDS.interactionRejectCancel, action_ts: "524.790", value }],
      },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(slackApiMock.respondToInteraction).toHaveBeenCalledTimes(2);
    call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    rendered = JSON.stringify(call?.[2]);
    expect(rendered).toContain("Confirmation requested");
    expect(rendered).toContain("Ship amber label proof");
    expect(rendered).toContain("Return violet label proof");
    expect(rendered).toContain(ACTION_IDS.interactionAccept);
    expect(rendered).toContain(ACTION_IDS.interactionRejectStart);
    expect(rendered).not.toContain("Decline notes");
    expect(rendered).not.toContain("Choose the primary action");
    expect(rendered).not.toContain("Sending back will ask for notes");
  });

  it("opens, cancels, and submits two-stage checkbox decline notes from the rendered Slack value", async () => {
    const checkboxRecord = {
      id: "interaction-check-reason",
      issueId: "issue-1",
      kind: "request_checkbox_confirmation",
      status: "pending",
      title: "Confirm selected checks",
      summary: "Pick a bounded set of checks.",
      payload: {
        version: 1,
        prompt: "Which checks may the agent proceed with?",
        detailsMarkdown: "Only select checks that are ready.",
        options: [
          { id: "docs", label: "Docs are updated" },
          { id: "tests", label: "Tests are green" },
        ],
        defaultSelectedOptionIds: ["docs"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Proceed with selected",
        rejectLabel: "Return with notes",
        rejectRequiresReason: true,
      },
      result: null,
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/issues/issue-1/interactions") && !init?.method) {
        return new Response(JSON.stringify([checkboxRecord]), { status: 200 });
      }
      if (url.endsWith("/api/issues/issue-1/interactions/interaction-check-reason/reject")) {
        return new Response(JSON.stringify({
          ...checkboxRecord,
          status: "rejected",
          result: { version: 1, outcome: "rejected", reason: "Use a safer subset." },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const { renderNotification } = await import("../src/block-kit/index.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];
    const initialCard = renderNotification({
      kind: "human.input_needed",
      eventId: "evt-checkbox-confirm",
      eventType: "human.input_needed",
      occurredAt: "2026-06-27T00:00:00.000Z",
      companyId: "company-1",
      companyPrefix: "COM",
      entityId: "issue-1",
      issueId: "issue-1",
      identifier: "COM-1",
      title: "Human input needed for checklist",
      interactionId: "interaction-check-reason",
      interactionKind: "request_checkbox_confirmation",
      interactionTitle: "Confirm selected checks",
      interactionSummary: "Pick a bounded set of checks.",
      interactionCheckboxConfirmation: checkboxRecord.payload,
      raw: {},
    } as any, { ...config, paperclipBaseUrl: "http://127.0.0.1:3100" });
    const rejectStartButton = collectButtons(initialCard).find((button) => button.action_id === ACTION_IDS.interactionRejectStart);
    expect(rejectStartButton).toBeTruthy();
    const value = String(rejectStartButton?.value);
    expect(JSON.parse(value)).toEqual(expect.objectContaining({
      issueId: "issue-1",
      interactionId: "interaction-check-reason",
      kind: "request_checkbox_confirmation",
      rejectRequiresReason: true,
      acceptLabel: "Proceed with selected",
      rejectLabel: "Return with notes",
      minSelected: 1,
      maxSelected: 2,
      defaultSelectedOptionIds: ["docs"],
    }));

    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        actions: [{ action_id: ACTION_IDS.interactionRejectStart, action_ts: "601.001", value }],
      },
    });
    let call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    let rendered = JSON.stringify(call?.[2]);
    expect(rendered).toContain("Send back with notes");
    expect(rendered).toContain("Decline notes");
    expect(rendered).toContain("Return with notes");
    expect(rendered).toContain(ACTION_IDS.interactionRejectCancel);

    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        actions: [{ action_id: ACTION_IDS.interactionRejectCancel, action_ts: "601.002", value }],
      },
    });
    call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    rendered = JSON.stringify(call?.[2]);
    expect(rendered).toContain("Checkbox confirmation requested");
    expect(rendered).toContain("Docs are updated");
    expect(rendered).toContain("Proceed with selected");
    expect(rendered).toContain("Return with notes");
    expect(rendered).toContain(ACTION_IDS.interactionCheckboxSelect);
    expect(rendered).toContain(ACTION_IDS.interactionRejectStart);
    expect(rendered).not.toContain("Decline notes");

    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        actions: [{ action_id: ACTION_IDS.interactionReject, action_ts: "601.003", value }],
        state: {
          values: {
            pc_interaction_reject_reason: {
              [ACTION_IDS.interactionRejectReason]: {
                type: "plain_text_input",
                value: "Use a safer subset.",
              },
            },
          },
        },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions/interaction-check-reason/reject",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "Use a safer subset." }) }),
    );
    call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    rendered = JSON.stringify(call?.[2]);
    expect(rendered).toContain("↩️ Sent back");
    expect(rendered).toContain("View in Paperclip");
    expect(rendered).not.toContain("Use a safer subset.");
  });

  it("renders and restores large checkbox confirmations as simple Paperclip-only notices", async () => {
    const options = Array.from({ length: 12 }, (_, index) => ({ id: `opt-${index + 1}`, label: `Option ${index + 1}` }));
    const checkboxRecord = {
      id: "interaction-check-many",
      issueId: "issue-1",
      kind: "request_checkbox_confirmation",
      status: "pending",
      title: "Confirm many checks",
      summary: "Pick many checks.",
      payload: {
        version: 1,
        prompt: "Which checks may the agent proceed with?",
        options,
        defaultSelectedOptionIds: options.map((option) => option.id),
        minSelected: 1,
        maxSelected: 12,
        acceptLabel: "Proceed with selected",
        rejectLabel: "Return with notes",
        rejectRequiresReason: true,
      },
      result: null,
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/issues/issue-1/interactions") && !init?.method) {
        return new Response(JSON.stringify([checkboxRecord]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const { renderNotification } = await import("../src/block-kit/index.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];
    const initialCard = renderNotification({
      kind: "human.input_needed",
      eventId: "evt-checkbox-many",
      eventType: "human.input_needed",
      occurredAt: "2026-06-27T00:00:00.000Z",
      companyId: "company-1",
      companyPrefix: "COM",
      issueId: "issue-1",
      identifier: "COM-1",
      title: "Human input needed for many checks",
      interactionId: "interaction-check-many",
      interactionKind: "request_checkbox_confirmation",
      interactionTitle: "Confirm many checks",
      interactionCheckboxConfirmation: checkboxRecord.payload,
      raw: {},
    } as any, { ...config, paperclipBaseUrl: "http://127.0.0.1:3100" });
    const initialRendered = JSON.stringify(initialCard);
    const initialActionIds = collectButtons(initialCard).map((button) => button.action_id);
    expect(initialRendered).toContain("COM-1 _This confirmation has more options than Slack can show inline");
    expect(initialRendered).toContain("Open the issue to choose them");
    expect(initialRendered).toContain("http://127.0.0.1:3100/issues/issue-1");
    expect(initialRendered).not.toContain("Confirm many checks");
    expect(initialRendered).not.toContain("Which checks may the agent proceed with?");
    expect(initialRendered).not.toContain("Select 1–12 options");
    expect(initialCard.blocks).toHaveLength(1);
    expect(initialActionIds).toEqual([]);

    const legacyValue = JSON.stringify({
      issueId: "issue-1",
      interactionId: "interaction-check-many",
      companyPrefix: "COM",
      kind: "request_checkbox_confirmation",
      rejectRequiresReason: true,
      optionActionId: ACTION_IDS.interactionCheckboxSelect,
    });
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        actions: [{ action_id: ACTION_IDS.interactionRejectCancel, action_ts: "602.002", value: legacyValue }],
      },
    });

    const call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    const renderedMessage = call?.[2];
    const rendered = JSON.stringify(renderedMessage);
    const actionIds = collectButtons(renderedMessage).map((button) => button.action_id);
    expect(rendered).toContain("issue-1 _This confirmation has more options than Slack can show inline");
    expect(rendered).toContain("Open the issue to choose them");
    expect(rendered).toContain("http://127.0.0.1:3100/COM/issues/issue-1");
    expect(rendered).not.toContain("Confirm many checks");
    expect(rendered).not.toContain("Which checks may the agent proceed with?");
    expect(rendered).not.toContain("Select 1–12 options");
    expect((renderedMessage as any).blocks).toHaveLength(1);
    expect(actionIds).toEqual([]);
  });

  it("asks for decline notes before final rejection when the two-stage form is blank", async () => {
    const { startSlackSocketMode } = await import("../src/socket-mode.js");
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      http: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) },
      metrics: { write: vi.fn(async () => undefined) },
      companies: { list: vi.fn(async () => []) },
      issues: { list: vi.fn(async () => []) },
    } as any;

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        trigger_id: "trigger-confirm-missing-reason",
        user: { id: "U1" },
        container: { message_ts: "525.456" },
        actions: [{
          action_id: ACTION_IDS.interactionReject,
          action_ts: "525.457",
          value: JSON.stringify({ issueId: "issue-1", interactionId: "interaction-confirm-1", companyPrefix: "COM", kind: "request_confirmation", rejectRequiresReason: true }),
        }],
        state: {
          values: {
            pc_interaction_reject_reason: {
              [ACTION_IDS.interactionRejectReason]: {
                type: "plain_text_input",
                value: "   ",
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
      expect.objectContaining({ text: expect.stringContaining("Decline needs notes") }),
      expect.objectContaining({ responseType: "ephemeral" }),
    );
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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
      expect.objectContaining({ text: "✅ Approved: Confirm selected checks" }),
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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
      expect.objectContaining({ text: "✅ Approved: Confirm deployment plan" }),
      expect.objectContaining({ replaceOriginal: true, responseType: "in_channel" }),
    );
  });

  it("checks stale state before opening the send-back notes form", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
    const client = socketMock.instances[0];
    await client.handlers.get("block_actions")?.({
      type: "block_actions",
      ack: vi.fn(async () => undefined),
      body: {
        type: "block_actions",
        response_url: "https://slack.example/response",
        actions: [{
          action_id: ACTION_IDS.interactionRejectStart,
          action_ts: "624.001",
          value: JSON.stringify({ issueId: "issue-1", interactionId: "interaction-confirm-1", companyPrefix: "COM", kind: "request_confirmation", rejectRequiresReason: true }),
        }],
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    const call = (slackApiMock.respondToInteraction.mock.calls as unknown[][]).at(-1);
    const rendered = JSON.stringify(call?.[2]);
    expect(rendered).toContain("✅ Approved");
    expect(rendered).toContain("Confirm deployment plan");
    expect(rendered).not.toContain("Decline notes");
    expect(rendered).not.toContain(ACTION_IDS.interactionReject);
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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
      expect.objectContaining({ text: expect.stringContaining("✅ Approved") }),
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

    await startSlackSocketMode(ctx, config, "test-bot-token", "test-app-token");
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

import { describe, expect, it } from "vitest";
import { ACTION_IDS } from "../src/constants.js";
import { assertSlackMessageBounds } from "../src/block-kit/limits.js";
import { parsePaperclipCommand, renderCommandResponse, renderInteractionAck } from "../src/slack-control.js";
import type { SlackNotificationsConfig } from "../src/types.js";

const config: SlackNotificationsConfig = {
  slackBotToken: "xoxb-redacted",
  slackAppToken: "xapp-redacted",
  defaultChannelId: "C0000000000",
  defaultCompanyId: "company-1",
  paperclipBaseUrl: "http://127.0.0.1:3100",
};

describe("Slack control surface", () => {
  it.each([
    ["", "status"],
    ["status", "status"],
    ["ping", "status"],
    ["help", "help"],
    ["companies", "companies"],
    ["company", "companies"],
    ["issues PRO", "issues"],
    ["tasks PRO", "issues"],
    ["issue PRO-1", "issue"],
    ["task PRO-1", "issue"],
    ["approvals", "approvals"],
    ["create PRO thing", "create"],
    ["link PRO-1", "unknown"],
    ["wakeup PRO-1", "wakeup"],
    ["something else", "unknown"],
  ] as const)("parses %j as %s", (input, expected) => {
    expect(parsePaperclipCommand(input).name).toBe(expected);
  });

  it.each(["status", "help", "approvals", "create PRO thing", "link PRO-1", "wakeup PRO-1", "issue PRO-1", "wat"])("renders bounded response for %s", (input) => {
    const message = renderCommandResponse(parsePaperclipCommand(input), config);
    expect(message.text).toBeTruthy();
    expect(message.blocks?.length).toBeGreaterThan(0);
    assertSlackMessageBounds(message);
  });

  it("renders visible companies", () => {
    const message = renderCommandResponse(parsePaperclipCommand("companies"), config, {
      companies: {
        companies: [
          { id: "company-1", name: "Product Org", issuePrefix: "PRO" },
          { id: "company-2", name: "Support", issuePrefix: "SUP" },
        ],
        total: 2,
      },
    });
    expect(JSON.stringify(message)).toContain("Product Org");
    expect(JSON.stringify(message)).toContain("PRO");
    assertSlackMessageBounds(message);
  });

  it("renders recent issues for a resolved company", () => {
    const message = renderCommandResponse(parsePaperclipCommand("issues PRO"), config, {
      issues: {
        company: { id: "company-1", name: "Product Org", issuePrefix: "PRO" },
        issues: [
          { id: "issue-1", identifier: "PRO-1", title: "Wire Slack commands", status: "open", priority: "high", assignee: "Builder" },
        ],
      },
    });
    expect(JSON.stringify(message)).toContain("PRO-1");
    expect(JSON.stringify(message)).toContain("Wire Slack commands");
    assertSlackMessageBounds(message);
  });

  it("renders issue detail", () => {
    const message = renderCommandResponse(parsePaperclipCommand("issue PRO-1"), config, {
      issue: {
        company: { id: "company-1", name: "Product Org", issuePrefix: "PRO" },
        issue: { id: "issue-1", identifier: "PRO-1", title: "Wire Slack commands", description: "Make Slack useful.", status: "open", priority: "high", assignee: "Builder" },
      },
    });
    expect(JSON.stringify(message)).toContain("Wire Slack commands");
    expect(JSON.stringify(message)).toContain("Make Slack useful");
    assertSlackMessageBounds(message);
  });

  it("renders a choose-company message when issues has no company", () => {
    const message = renderCommandResponse(parsePaperclipCommand("issues"), { ...config, defaultCompanyId: undefined }, {
      issues: { issues: [], note: "Try one of: PRO, SUP." },
    });
    expect(JSON.stringify(message)).toContain("Try one of");
    assertSlackMessageBounds(message);
  });

  it("renders approval action fallback acknowledgement", () => {
    const message = renderInteractionAck(ACTION_IDS.approvalApprove, "approval-1", config);
    expect(JSON.stringify(message)).toContain("direct Paperclip API call is unavailable");
    assertSlackMessageBounds(message);
  });
});

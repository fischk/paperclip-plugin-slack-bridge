import { ACTION_IDS, DEFAULT_PAPERCLIP_BASE_URL } from "./constants.js";
import type { SlackMessage, SlackNotificationsConfig } from "./types.js";
import { actionBlock, linkButton, mrkdwn, paperclipUrl, section } from "./block-kit/common.js";
import { assertSlackMessageBounds, truncateText } from "./block-kit/limits.js";

export type PaperclipCommandName = "status" | "help" | "companies" | "issues" | "issue" | "approvals" | "create" | "wakeup" | "unknown";

export interface ParsedPaperclipCommand {
  name: PaperclipCommandName;
  args: string;
  raw: string;
}

export interface RuntimeCompanySummary {
  id: string;
  name: string;
  issuePrefix?: string;
}

export interface RuntimeIssueSummary {
  id: string;
  title: string;
  identifier?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RuntimeStatusSummary {
  visibleCompanyCount?: number;
  companyLabels?: string[];
  note?: string;
}

export interface RuntimeCommandResult {
  ok: boolean;
  title: string;
  body: string;
  issue?: RuntimeIssueSummary;
  company?: RuntimeCompanySummary;
  urlPath?: string;
}

export interface RuntimeCommandData {
  status?: RuntimeStatusSummary;
  companies?: {
    companies: RuntimeCompanySummary[];
    total?: number;
    note?: string;
  };
  issues?: {
    company?: RuntimeCompanySummary;
    issues: RuntimeIssueSummary[];
    query?: string;
    note?: string;
  };
  issue?: {
    company?: RuntimeCompanySummary;
    issue?: RuntimeIssueSummary;
    query?: string;
    note?: string;
  };
  create?: RuntimeCommandResult;
  wakeup?: RuntimeCommandResult;
}

export function parsePaperclipCommand(rawInput: string | undefined): ParsedPaperclipCommand {
  const raw = (rawInput ?? "").trim();
  if (!raw) return { name: "status", args: "", raw };
  const [first = "", ...rest] = raw.split(/\s+/);
  const normalized = first.toLowerCase();
  const args = rest.join(" ").trim();
  if (["status", "ping", "up"].includes(normalized)) return { name: "status", args, raw };
  if (["help", "?"].includes(normalized)) return { name: "help", args, raw };
  if (["companies", "company", "cos"].includes(normalized)) return { name: "companies", args, raw };
  if (["issues", "tasks"].includes(normalized)) return { name: "issues", args, raw };
  if (["issue", "task", "show", "open"].includes(normalized)) return { name: "issue", args, raw };
  if (["approvals", "approval"].includes(normalized)) return { name: "approvals", args, raw };
  if (["create", "new"].includes(normalized)) return { name: "create", args, raw };
  if (["wakeup", "wake", "run"].includes(normalized)) return { name: "wakeup", args, raw };
  return { name: "unknown", args: raw, raw };
}

export function renderCommandResponse(command: ParsedPaperclipCommand, config: SlackNotificationsConfig, data: RuntimeCommandData = {}): SlackMessage {
  switch (command.name) {
    case "status": return renderStatusMessage(config, data.status);
    case "help": return renderHelpMessage(config);
    case "companies": return renderCompaniesMessage(data.companies, config);
    case "issues": return renderIssuesMessage(data.issues, config);
    case "issue": return renderIssueDetailMessage(data.issue, config);
    case "approvals": return renderRoadmapMessage("Approvals", "Approval requests are surfaced through blocked-inbox HITL cards. Approve/Reject/Request revision buttons call Paperclip's approval API from Slack.", config);
    case "create": return renderCommandResultMessage(data.create, config, "Create issue");
    case "wakeup": return renderCommandResultMessage(data.wakeup, config, "Wake issue assignee");
    case "unknown": return renderUnknownMessage(command.raw, config);
  }
}

export function renderStatusMessage(config: SlackNotificationsConfig, summary?: RuntimeStatusSummary): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  const companyText = summary?.companyLabels?.length
    ? `\nVisible companies: ${summary.companyLabels.map((label) => `\`${label}\``).join(", ")}${summary.visibleCompanyCount && summary.visibleCompanyCount > summary.companyLabels.length ? ` +${summary.visibleCompanyCount - summary.companyLabels.length} more` : ""}`
    : "";
  const defaultCompany = config.defaultCompanyId ? `\nDefault company: \`${config.defaultCompanyId}\`` : "";
  const note = summary?.note ? `\n_${summary.note}_` : "";
  const blocks = [
    section(`*Paperclip is connected.*\nSocket Mode ingress is online. Paperclip event notifications are enabled; Slack control flows are deterministic.${companyText}${defaultCompany}${note}`),
    {
      type: "context",
      elements: [
        mrkdwn(`Default channel: \`${config.defaultChannelId}\``),
        mrkdwn(`Socket Mode: \`${config.socketModeEnabled === false ? "disabled" : "enabled"}\``),
      ],
    },
    actionBlock([
      linkButton("Open Paperclip", baseUrl, ACTION_IDS.paperclipHomeOpen),
    ]),
  ];
  const message = { text: "Paperclip is connected.", blocks };
  assertSlackMessageBounds(message);
  return message;
}

export function renderHelpMessage(config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  const blocks = [
    section("*Paperclip Slack commands*\n`/paperclip status` — connection/status card\n`/paperclip companies` — list visible Paperclip companies\n`/paperclip issues <company>` — list recent issues for a company prefix/name/id\n`/paperclip issue <key-or-id>` — show a detailed issue card\n`/paperclip create <company> <title>` — create a Paperclip issue\n`/paperclip wakeup <key-or-id>` — request assignee wakeup for an issue\n`/paperclip help` — this help card"),
    section("Write posture: create/wakeup use current Paperclip plugin SDK methods. Approval buttons call the local Paperclip approval API for HITL approval cards."),
    actionBlock([
      linkButton("Open Paperclip", baseUrl, ACTION_IDS.paperclipHomeOpen),
    ]),
  ];
  const message = { text: "Paperclip Slack command help.", blocks };
  assertSlackMessageBounds(message);
  return message;
}

export function renderCompaniesMessage(summary: RuntimeCommandData["companies"] | undefined, config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  const companies = summary?.companies ?? [];
  const lines = companies.length
    ? companies.map((company) => `• ${company.issuePrefix ? `\`${company.issuePrefix}\` ` : ""}*${escapeMrkdwn(company.name)}* — \`${company.id}\``).join("\n")
    : "No visible companies were returned by the Paperclip SDK.";
  const total = summary?.total && summary.total > companies.length ? `\n_Showing ${companies.length} of ${summary.total}._` : "";
  const note = summary?.note ? `\n_${summary.note}_` : "";
  const blocks = [
    section(`*Visible Paperclip companies*\n${lines}${total}${note}`),
    actionBlock([linkButton("Open Paperclip", baseUrl, ACTION_IDS.paperclipHomeOpen)]),
  ];
  const message = { text: "Visible Paperclip companies.", blocks };
  assertSlackMessageBounds(message);
  return message;
}

export function renderIssuesMessage(summary: RuntimeCommandData["issues"] | undefined, config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  if (!summary?.company) {
    const query = summary?.query ? ` for \`${summary.query}\`` : "";
    const note = summary?.note ?? "Use `/paperclip companies` to pick a company, then `/paperclip issues <prefix-or-name>`.";
    const message = {
      text: "Choose a Paperclip company before listing issues.",
      blocks: [section(`*Issues${query}*\n${note}`), actionBlock([linkButton("Open Paperclip", baseUrl, ACTION_IDS.paperclipHomeOpen)])],
    };
    assertSlackMessageBounds(message);
    return message;
  }

  const company = summary.company;
  const companyPath = company.issuePrefix ? `/${company.issuePrefix}/issues` : "/issues";
  const heading = company.issuePrefix ? `${company.name} (${company.issuePrefix})` : company.name;
  const lines = summary.issues.length
    ? summary.issues.map((issue) => renderIssueLine(issue, baseUrl, company)).join("\n")
    : "No recent issues were returned for this company.";
  const note = summary.note ? `\n_${summary.note}_` : "";
  const blocks = [
    section(`*Recent issues — ${escapeMrkdwn(heading)}*\n${lines}${note}`),
    actionBlock([linkButton("Open Issues", paperclipUrl(baseUrl, companyPath), ACTION_IDS.issueOpen)]),
  ];
  const message = { text: `Recent Paperclip issues for ${heading}.`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

export function renderIssueDetailMessage(summary: RuntimeCommandData["issue"] | undefined, config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  if (!summary?.issue || !summary.company) {
    const query = summary?.query ? `\`${summary.query}\`` : "that issue";
    const note = summary?.note ?? "Try `/paperclip issues <company>` first, then `/paperclip issue <issue-key>`.";
    const message = { text: "Paperclip issue not found.", blocks: [section(`*Issue ${query}*\n${note}`)] };
    assertSlackMessageBounds(message);
    return message;
  }
  const issue = summary.issue;
  const company = summary.company;
  const label = issue.identifier ?? issue.id;
  const path = company.issuePrefix && issue.identifier ? `/${company.issuePrefix}/issues/${issue.identifier}` : `/issues/${issue.id}`;
  const fields = [
    `*Status:* ${issue.status ?? "unknown"}`,
    `*Priority:* ${issue.priority ?? "unset"}`,
    `*Assignee:* ${issue.assignee ?? "unassigned"}`,
    `*Company:* ${company.issuePrefix ? `${company.name} (${company.issuePrefix})` : company.name}`,
  ];
  const description = issue.description ? `\n${escapeMrkdwn(truncateText(issue.description, 900))}` : "";
  const blocks = [
    section(`*${escapeMrkdwn(label)} — ${escapeMrkdwn(truncateText(issue.title, 180))}*${description}`),
    { type: "section", fields: fields.map((text) => mrkdwn(text)) },
    actionBlock([linkButton("Open Issue", paperclipUrl(baseUrl, path), ACTION_IDS.issueOpen)]),
  ];
  const message = { text: `Paperclip issue ${label}: ${issue.title}`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

export function renderCommandResultMessage(result: RuntimeCommandResult | undefined, config: SlackNotificationsConfig, fallbackTitle: string): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  const effective = result ?? { ok: false, title: fallbackTitle, body: "Command did not return a result." };
  const status = effective.ok ? "✅" : "⚠️";
  const body = `*${status} ${escapeMrkdwn(effective.title)}*\n${escapeMrkdwn(effective.body)}`;
  const buttons = [linkButton("Open Paperclip", baseUrl, ACTION_IDS.paperclipHomeOpen)];
  if (effective.urlPath) buttons.unshift(linkButton("Open Issue", paperclipUrl(baseUrl, effective.urlPath), ACTION_IDS.issueOpen));
  const blocks = [section(body), actionBlock(buttons)];
  const message = { text: `${effective.title}: ${effective.body}`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

export function renderInteractionAck(actionId: string, value: string | undefined, config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  const actionLabel = actionIdToLabel(actionId);
  const body = actionId === ACTION_IDS.approvalApprove || actionId === ACTION_IDS.approvalDeny || actionId === ACTION_IDS.approvalRequestRevision
    ? `${actionLabel} received for \`${value ?? "unknown approval"}\`. If the direct Paperclip API call is unavailable, open Paperclip to finish the approval manually.`
    : `${actionLabel} received.`;
  const blocks = [
    section(`*${actionLabel}*\n${body}`),
    actionBlock([linkButton("Open Paperclip", paperclipUrl(baseUrl, "/"), ACTION_IDS.paperclipHomeOpen)]),
  ];
  const message = { text: `${actionLabel} received.`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

function renderIssueLine(issue: RuntimeIssueSummary, baseUrl: string, company: RuntimeCompanySummary): string {
  const label = issue.identifier ?? issue.id;
  const status = issue.status ? ` • ${issue.status}` : "";
  const priority = issue.priority ? ` • ${issue.priority}` : "";
  const assignee = issue.assignee ? ` • ${issue.assignee}` : "";
  const path = company.issuePrefix && issue.identifier ? `/${company.issuePrefix}/issues/${issue.identifier}` : `/issues/${issue.id}`;
  return `• <${paperclipUrl(baseUrl, path)}|${escapeMrkdwn(label)}> — ${escapeMrkdwn(truncateText(issue.title, 120))}${status}${priority}${assignee}`;
}

function renderRoadmapMessage(title: string, body: string, config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  const blocks = [
    section(`*${title}*\n${body}`),
    actionBlock([linkButton("Open Paperclip", baseUrl, ACTION_IDS.paperclipHomeOpen)]),
  ];
  const message = { text: `Paperclip ${title}: ${body}`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

function renderUnknownMessage(raw: string, config: SlackNotificationsConfig): SlackMessage {
  const help = renderHelpMessage(config);
  const message = {
    text: `Unknown Paperclip command: ${raw}`,
    blocks: [section(`Unknown Paperclip command: \`${raw}\`.`), ...(help.blocks ?? [])],
  };
  assertSlackMessageBounds(message);
  return message;
}

function actionIdToLabel(actionId: string): string {
  switch (actionId) {
    case ACTION_IDS.approvalApprove: return "Approve approval";
    case ACTION_IDS.approvalDeny: return "Reject approval";
    case ACTION_IDS.approvalRequestRevision: return "Request approval revision";
    case ACTION_IDS.approvalOpen: return "Open approval";
    case ACTION_IDS.issueOpen: return "Open issue";
    case ACTION_IDS.runOpen: return "Open run";
    case ACTION_IDS.paperclipHomeOpen: return "Open Paperclip";
    default: return "Paperclip action";
  }
}

function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

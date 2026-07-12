import { ACTION_IDS } from "../constants.js";
import type { NormalizedNotification, SlackMessage } from "../types.js";
import { actionBlock, button, contextFooter, fieldsBlock, linkButton, paperclipUrl, section } from "./common.js";
import { assertSlackMessageBounds, truncateText } from "./limits.js";

export function renderApprovalCard(notification: NormalizedNotification, baseUrl: string): SlackMessage {
  const approvalId = notification.approvalId ?? notification.entityId ?? notification.eventId;
  const actionValue = approvalActionValue(approvalId, notification.companyPrefix);
  const url = notification.url ?? paperclipUrl(baseUrl, approvalPath(approvalId, notification.companyPrefix));
  const isPendingRequest = notification.kind === "approval.created" && (!notification.status || notification.status === "pending");
  const approvalTitle = notification.approvalTitle ?? notification.title;
  if (!isPendingRequest) {
    return renderResolvedApprovalReceipt(notification.status, approvalTitle, url);
  }
  const heading = "*Approval requested* :rotating_light:";
  const summary = notification.summary ?? notification.description;
  const fields = fieldsBlock([
    ["Type", humanizeApprovalType(notification.approvalType)],
    ["Status", notification.status],
    ["Requested by", notification.requestedByName ?? notification.agentName],
    ["Company", notification.companyPrefix ?? notification.companyName],
  ]);
  const linkedIssues = renderLinkedIssues(notification.linkedIssues, notification.issueIds);
  const actions = isPendingRequest
    ? [
      button("Approve", ACTION_IDS.approvalApprove, actionValue, "primary"),
      button("Reject", ACTION_IDS.approvalDeny, actionValue, "danger"),
      button("Request revision", ACTION_IDS.approvalRequestRevision, actionValue),
      linkButton("Open in Paperclip", url, ACTION_IDS.approvalOpen),
    ]
    : [linkButton("Open in Paperclip", url, ACTION_IDS.approvalOpen)];
  const blocks = [
    section(`${heading}\n*${truncateText(approvalTitle, 220)}*`),
    ...(summary ? [section(`*Summary*\n${truncateText(summary, 1450)}`)] : []),
    ...(notification.recommendedAction ? [section(`*Recommended action*\n${quoteForSlack(truncateText(notification.recommendedAction, 1100))}`)] : []),
    ...(notification.risks && notification.risks.length > 0 ? [section(`*Risks*\n${notification.risks.slice(0, 4).map((risk) => `• ${truncateText(risk, 320)}`).join("\n")}`)] : []),
    ...(linkedIssues ? [section(linkedIssues)] : []),
    ...(fields ? [fields] : []),
    ...(notification.decisionNote ? [section(`*Decision note*\n${truncateText(notification.decisionNote, 600)}`)] : []),
    actionBlock(actions),
    contextFooter(notification),
  ];
  const message = { text: `${isPendingRequest ? "Approval requested" : humanizeApprovalStatus(notification.status)}: ${approvalTitle}`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

function approvalPath(approvalId: string, companyPrefix?: string): string {
  return companyPrefix ? `/${companyPrefix}/approvals/${approvalId}` : `/approvals/${approvalId}`;
}

function renderResolvedApprovalReceipt(status: string | undefined, title: string, url: string): SlackMessage {
  const label = approvalReceiptLabel(status);
  const safeTitle = truncateText(title, 220);
  return {
    text: `${label}: ${safeTitle}`,
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `${label} · <${url}|View in Paperclip>\n${safeTitle}` },
    }],
  };
}

function approvalReceiptLabel(status?: string): string {
  switch (status) {
    case "approved": return "✅ Approved";
    case "rejected": return "↩️ Rejected";
    case "revision_requested": return "↩️ Revision requested";
    default: return status ? `ℹ️ ${humanizeApprovalStatus(status)}` : "ℹ️ Approval decided";
  }
}

function approvalActionValue(approvalId: string, companyPrefix?: string): string {
  return companyPrefix ? JSON.stringify({ approvalId, companyPrefix }) : approvalId;
}

function humanizeApprovalType(type?: string): string | undefined {
  if (!type) return undefined;
  const labels: Record<string, string> = {
    hire_agent: "Hire Agent",
    approve_ceo_strategy: "CEO Strategy",
    budget_override_required: "Budget Override",
    request_board_approval: "Board Approval",
  };
  return labels[type] ?? type;
}

function humanizeApprovalStatus(status?: string): string {
  const labels: Record<string, string> = {
    approved: "Approval approved",
    rejected: "Approval rejected",
    revision_requested: "Revision requested",
    pending: "Approval requested",
  };
  return status ? labels[status] ?? `Approval ${status.replace(/_/g, " ")}` : "Approval decided";
}

function renderLinkedIssues(
  linkedIssues?: Array<{ id?: string; identifier?: string; title?: string }>,
  fallbackIssueIds?: string[],
): string | undefined {
  if (linkedIssues && linkedIssues.length > 0) {
    const rendered = linkedIssues.slice(0, 4).map((issue) => {
      const key = issue.identifier ?? issue.id ?? "issue";
      const title = issue.title ? ` — ${truncateText(issue.title, 220)}` : "";
      return `• \`${key}\`${title}`;
    });
    return `*Linked task${linkedIssues.length === 1 ? "" : "s"}*\n${rendered.join("\n")}`;
  }
  if (fallbackIssueIds && fallbackIssueIds.length > 0) {
    return `*Linked task${fallbackIssueIds.length === 1 ? "" : "s"}*\n${fallbackIssueIds.map((id) => `• \`${id}\``).join("\n")}`;
  }
  return undefined;
}

function quoteForSlack(text: string): string {
  return text.split("\n").map((line) => `>${line}`).join("\n");
}

import { ACTION_IDS, DEFAULT_PAPERCLIP_BASE_URL } from "../constants.js";
import type { RuntimeCompanySummary, RuntimeIssueSummary } from "../slack-control.js";
import type { SlackMessage, SlackNotificationsConfig } from "../types.js";

export function approvalPath(approvalId: string, companyPrefix?: string): string {
  return companyPrefix ? `/${companyPrefix}/approvals/${approvalId}` : `/approvals/${approvalId}`;
}

export function issueInteractionPath(issueId: string, companyPrefix?: string): string {
  return companyPrefix ? `/${companyPrefix}/issues/${issueId}` : `/issues/${issueId}`;
}

export function simpleMessage(title: string, body: string, config: SlackNotificationsConfig, urlOverride?: string): SlackMessage {
  const baseUrl = urlOverride ?? config.paperclipBaseUrl ?? DEFAULT_PAPERCLIP_BASE_URL;
  return {
    text: `${title}: ${body}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${body}` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Paperclip" }, url: baseUrl, action_id: ACTION_IDS.paperclipHomeOpen }] },
    ],
  };
}

export function issuePath(issue: RuntimeIssueSummary, company: RuntimeCompanySummary): string {
  return company.issuePrefix && issue.identifier ? `/${company.issuePrefix}/issues/${issue.identifier}` : `/issues/${issue.id}`;
}

export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function stripSlackMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function recordField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(stringField).filter((item): item is string => Boolean(item));
  return values.length > 0 ? values : undefined;
}

export function stringRecordField(value: unknown): Record<string, string> {
  const record = recordField(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record)
    .map(([key, raw]) => [key, stringField(raw)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[1])));
}

export function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

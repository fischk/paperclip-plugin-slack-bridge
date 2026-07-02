import { DEFAULT_PAPERCLIP_BASE_URL, PLUGIN_ID } from "../constants.js";
import { hostErrorText, recordHostCallFailure, type HostCallSurface } from "../host-errors.js";
import { postMessage, respondToInteraction } from "../slack-api.js";
import { parsePaperclipCommand, renderCommandResponse, type RuntimeCommandData, type RuntimeCommandResult, type RuntimeCompanySummary, type RuntimeIssueSummary, type RuntimeStatusSummary } from "../slack-control.js";
import type { SlackNotificationsConfig } from "../types.js";
import type { CommandContext, SocketContext } from "./types.js";
import { issuePath, looksLikeUuid, recordField, stringField, stripSlackMentions } from "./utils.js";

export async function handleSlackEvent(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  botToken: string,
  event: Record<string, unknown>,
): Promise<void> {
  const eventType = String(event.type ?? "unknown");
  if (event.bot_id || event.subtype === "bot_message") return;

  if (eventType === "app_mention") {
    const channel = stringField(event.channel) ?? config.defaultChannelId;
    const threadTs = stringField(event.thread_ts) ?? stringField(event.ts);
    const commandText = stripSlackMentions(stringField(event.text) ?? "");
    const message = await buildCommandMessage(ctx, config, commandText, {
      source: "mention",
      channelId: channel,
      threadTs,
      userId: stringField(event.user),
    });
    await postMessage(ctx, botToken, channel, message, threadTs ? { threadTs } : undefined);
    await ctx.metrics.write("slack_socket_app_mention_replied", 1);
    return;
  }

  if (eventType === "assistant_thread_started" || eventType === "assistant_thread_context_changed") {
    const channel = stringField(event.channel_id) ?? stringField(event.channel) ?? config.defaultChannelId;
    const threadTs = stringField(event.thread_ts) ?? stringField(recordField(event.thread)?.ts) ?? stringField(event.ts);
    await postMessage(ctx, botToken, channel, await buildCommandMessage(ctx, config, "status", { source: "assistant", channelId: channel, threadTs }), threadTs ? { threadTs } : undefined);
    await ctx.metrics.write("slack_socket_assistant_event_replied", 1, { eventType });
    return;
  }

  if (eventType === "message") {
    ctx.logger.debug("Received Slack message event", { channel: stringField(event.channel), threadTs: stringField(event.thread_ts) });
    return;
  }

  ctx.logger.debug("Ignored Slack event", { eventType });
}

export async function handleSlashCommand(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  botToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const channelId = stringField(body.channel_id) ?? config.defaultChannelId;
  const responseUrl = stringField(body.response_url);
  const text = stringField(body.text) ?? "";
  const message = await buildCommandMessage(ctx, config, text, { source: "slash", channelId, userId: stringField(body.user_id) });

  if (responseUrl) {
    await respondToInteraction(ctx, responseUrl, message, { responseType: "ephemeral" });
    await ctx.metrics.write("slack_socket_slash_command_replied", 1, { via: "response_url" });
    return;
  }

  await postMessage(ctx, botToken, channelId, message);
  await ctx.metrics.write("slack_socket_slash_command_replied", 1, { via: "postMessage" });
}

async function buildCommandMessage(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  text: string,
  commandContext: CommandContext,
) {
  const command = parsePaperclipCommand(text);
  return renderCommandResponse(command, config, await collectCommandData(ctx, config, command, commandContext));
}

async function collectCommandData(ctx: SocketContext, config: SlackNotificationsConfig, command: ReturnType<typeof parsePaperclipCommand>, commandContext: CommandContext): Promise<RuntimeCommandData> {
  const surface = commandSurface(commandContext);
  switch (command.name) {
    case "status": return { status: await collectRuntimeStatusSummary(ctx, surface) };
    case "companies": return { companies: await collectCompaniesSummary(ctx, surface) };
    case "issues": return { issues: await collectIssuesSummary(ctx, config, command.args, surface) };
    case "issue": return { issue: await collectIssueDetail(ctx, config, command.args, surface) };
    case "create": return { create: await createIssueFromCommand(ctx, config, command.args, surface) };
    case "wakeup": return { wakeup: await wakeupIssueFromCommand(ctx, config, command.args, surface) };
    default: return {};
  }
}

function commandSurface(commandContext: CommandContext): HostCallSurface {
  return commandContext.source === "slash" ? "slash_command" : "app_mention";
}

async function collectRuntimeStatusSummary(ctx: SocketContext, surface: HostCallSurface): Promise<RuntimeStatusSummary> {
  try {
    const companies = await ctx.companies.list({ limit: 6 });
    return {
      visibleCompanyCount: companies.length,
      companyLabels: companies.slice(0, 5).map((company) => {
        const record = company as unknown as Record<string, unknown>;
        const prefix = stringField(record.issuePrefix);
        const name = stringField(record.name) ?? stringField(record.id) ?? "company";
        return prefix ? `${name} (${prefix})` : name;
      }),
    };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "companies.list", error);
    ctx.logger.warn("Failed to enrich Slack status card with Paperclip company summary", { error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { note: hostErrorText(errorKind) };
  }
}

async function collectCompaniesSummary(ctx: SocketContext, surface: HostCallSurface): Promise<{ companies: RuntimeCompanySummary[]; total?: number; note?: string }> {
  try {
    const companies = await listCompanies(ctx, 25);
    return { companies: companies.slice(0, 20), total: companies.length };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "companies.list", error);
    ctx.logger.warn("Failed to list Paperclip companies for Slack command", { error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { companies: [], note: hostErrorText(errorKind) };
  }
}

async function collectIssuesSummary(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  query: string,
  surface: HostCallSurface,
): Promise<{ company?: RuntimeCompanySummary; issues: RuntimeIssueSummary[]; query?: string; note?: string }> {
  let companies: RuntimeCompanySummary[];
  try {
    companies = await listCompanies(ctx, 50);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "companies.list", error);
    ctx.logger.warn("Failed to resolve Paperclip company for issues command", { error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { issues: [], query: query || config.defaultCompanyId, note: hostErrorText(errorKind) };
  }
  const company = resolveCompany(companies, query, config.defaultCompanyId);
  if (!company) {
    return {
      issues: [],
      query: query || config.defaultCompanyId,
      note: companies.length
        ? `I couldn't determine which company to use. Try one of: ${companies.slice(0, 8).map((c) => c.issuePrefix ?? c.name).join(", ")}.`
        : "No visible companies were returned by the Paperclip SDK.",
    };
  }

  try {
    const issues = await ctx.issues.list({ companyId: company.id, limit: 12, includePluginOperations: true });
    return { company, issues: issues.map(toIssueSummary) };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "issues.list", error);
    ctx.logger.warn("Failed to list Paperclip issues for Slack command", { companyId: company.id, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { company, issues: [], note: hostErrorText(errorKind) };
  }
}

async function collectIssueDetail(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  query: string,
  surface: HostCallSurface,
): Promise<{ company?: RuntimeCompanySummary; issue?: RuntimeIssueSummary; query?: string; note?: string }> {
  const resolved = await resolveIssue(ctx, config, query, surface);
  if (!resolved.issue || !resolved.company) return { query, note: resolved.note };
  try {
    const full = await ctx.issues.get(resolved.issue.id, resolved.company.id);
    return { company: resolved.company, issue: toIssueSummary(full ?? resolved.issue) };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "issues.get", error);
    ctx.logger.warn("Failed to fetch issue detail for Slack command", { issueId: resolved.issue.id, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { company: resolved.company, issue: resolved.issue, note: hostErrorText(errorKind) };
  }
}

async function createIssueFromCommand(ctx: SocketContext, config: SlackNotificationsConfig, args: string, surface: HostCallSurface): Promise<RuntimeCommandResult> {
  let companies: RuntimeCompanySummary[];
  try {
    companies = await listCompanies(ctx, 50);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "companies.list", error);
    ctx.logger.warn("Failed to resolve Paperclip company for create command", { error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, title: "Create issue failed", body: hostErrorText(errorKind) };
  }
  const parsed = parseCompanyScopedText(companies, args, config.defaultCompanyId);
  if (!parsed.company) {
    return { ok: false, title: "Create issue", body: companies.length ? `Choose a company first. Try: ${companies.slice(0, 8).map((c) => c.issuePrefix ?? c.name).join(", ")}.` : "No visible companies are available." };
  }
  const title = parsed.text.trim();
  if (!title) return { ok: false, title: "Create issue", body: "Usage: `/paperclip create <company> <title>`." };
  try {
    const issue = await ctx.issues.create({
      companyId: parsed.company.id,
      title,
      originKind: `plugin:${PLUGIN_ID}:slack`,
      originId: `slack:${Date.now()}`,
      surfaceVisibility: "default",
    });
    const summary = toIssueSummary(issue);
    return {
      ok: true,
      title: "Issue created",
      body: `${summary.identifier ?? summary.id} — ${summary.title}`,
      issue: summary,
      company: parsed.company,
      urlPath: issuePath(summary, parsed.company),
    };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "issues.create", error);
    ctx.logger.warn("Failed to create Paperclip issue from Slack", { companyId: parsed.company.id, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, title: "Create issue failed", body: hostErrorText(errorKind) };
  }
}

async function wakeupIssueFromCommand(ctx: SocketContext, config: SlackNotificationsConfig, args: string, surface: HostCallSurface): Promise<RuntimeCommandResult> {
  const resolved = await resolveIssue(ctx, config, args, surface);
  if (!resolved.issue || !resolved.company) return { ok: false, title: "Wake issue assignee", body: resolved.note ?? "Issue not found." };
  try {
    const result = await ctx.issues.requestWakeup(resolved.issue.id, resolved.company.id, {
      reason: "Requested from Slack via Paperclip plugin.",
      contextSource: "slack",
      idempotencyKey: `slack-wakeup:${resolved.issue.id}:${new Date().toISOString().slice(0, 10)}`,
    });
    return {
      ok: true,
      title: result.queued ? "Wakeup queued" : "Wakeup not queued",
      body: result.queued ? `Queued run ${result.runId ?? "unknown"} for ${resolved.issue.identifier ?? resolved.issue.id}.` : `No wakeup was queued for ${resolved.issue.identifier ?? resolved.issue.id}.`,
      issue: resolved.issue,
      company: resolved.company,
      urlPath: issuePath(resolved.issue, resolved.company),
    };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "issues.requestWakeup", error);
    ctx.logger.warn("Failed to request issue wakeup from Slack", { issueId: resolved.issue.id, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, title: "Wakeup failed", body: hostErrorText(errorKind) };
  }
}

async function resolveIssue(ctx: SocketContext, config: SlackNotificationsConfig, rawQuery: string, surface: HostCallSurface): Promise<{ company?: RuntimeCompanySummary; issue?: RuntimeIssueSummary; note?: string }> {
  const query = rawQuery.trim();
  if (!query) return { note: "Usage: `/paperclip issue <company-prefix-and-key-or-id>`." };
  let companies: RuntimeCompanySummary[];
  try {
    companies = await listCompanies(ctx, 80);
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, "companies.list", error);
    ctx.logger.warn("Failed to resolve Paperclip company for issue command", { error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { note: hostErrorText(errorKind) };
  }
  const parsed = parseIssueQuery(companies, query, config.defaultCompanyId);
  const company = parsed.company;
  if (!company) return { note: companies.length ? `Could not resolve company. Try: ${companies.slice(0, 8).map((c) => c.issuePrefix ?? c.name).join(", ")}.` : "No visible companies are available." };
  try {
    if (looksLikeUuid(parsed.issueRef)) {
      const issue = await ctx.issues.get(parsed.issueRef, company.id);
      return issue ? { company, issue: toIssueSummary(issue) } : { company, note: `No issue found for ${parsed.issueRef}.` };
    }
    const issues = await ctx.issues.list({ companyId: company.id, limit: 100, includePluginOperations: true });
    const needle = parsed.issueRef.toLowerCase();
    const found = issues.map(toIssueSummary).find((issue) =>
      issue.id.toLowerCase() === needle
      || issue.identifier?.toLowerCase() === needle
      || issue.title.toLowerCase().includes(needle)
    );
    return found ? { company, issue: found } : { company, note: `No recent issue matched ${parsed.issueRef}. Try \`/paperclip issues ${company.issuePrefix ?? company.name}\`.` };
  } catch (error) {
    const errorKind = recordHostCallFailure(ctx, surface, looksLikeUuid(parsed.issueRef) ? "issues.get" : "issues.list", error);
    ctx.logger.warn("Failed to resolve Paperclip issue for Slack command", { query, companyId: company.id, error_kind: errorKind, error: error instanceof Error ? error.message : String(error) });
    return { company, note: hostErrorText(errorKind) };
  }
}

async function listCompanies(ctx: SocketContext, limit: number): Promise<RuntimeCompanySummary[]> {
  const companies = await ctx.companies.list({ limit });
  return companies.map(toCompanySummary);
}

function resolveCompany(companies: RuntimeCompanySummary[], query: string, defaultCompanyId?: string): RuntimeCompanySummary | undefined {
  const needle = (query || defaultCompanyId || "").trim().toLowerCase();
  if (!needle) return companies.length === 1 ? companies[0] : undefined;
  return companies.find((company) =>
    company.id.toLowerCase() === needle
    || company.issuePrefix?.toLowerCase() === needle
    || company.name.toLowerCase() === needle
    || company.name.toLowerCase().includes(needle)
  );
}

function parseCompanyScopedText(companies: RuntimeCompanySummary[], args: string, defaultCompanyId?: string): { company?: RuntimeCompanySummary; text: string } {
  const [first = "", ...rest] = args.trim().split(/\s+/);
  const explicit = resolveCompany(companies, first, undefined);
  if (explicit) return { company: explicit, text: rest.join(" ").trim() };
  return { company: resolveCompany(companies, "", defaultCompanyId), text: args.trim() };
}

function parseIssueQuery(companies: RuntimeCompanySummary[], query: string, defaultCompanyId?: string): { company?: RuntimeCompanySummary; issueRef: string } {
  const [first = "", second = "", ...rest] = query.split(/\s+/);
  const explicitCompany = resolveCompany(companies, first, undefined);
  if (explicitCompany && second) return { company: explicitCompany, issueRef: [second, ...rest].join(" ").trim() };
  const prefix = first.match(/^([A-Za-z][A-Za-z0-9]*)[-_]/)?.[1];
  const prefixCompany = prefix ? resolveCompany(companies, prefix, undefined) : undefined;
  return { company: prefixCompany ?? resolveCompany(companies, "", defaultCompanyId), issueRef: query.trim() };
}

function toCompanySummary(company: unknown): RuntimeCompanySummary {
  const record = recordField(company) ?? {};
  const id = stringField(record.id) ?? "unknown-company";
  return {
    id,
    name: stringField(record.name) ?? id,
    issuePrefix: stringField(record.issuePrefix),
  };
}

function toIssueSummary(issue: unknown): RuntimeIssueSummary {
  const record = recordField(issue) ?? {};
  const assignee = recordField(record.assignee) ?? recordField(record.assigneeAgent) ?? recordField(record.assigneeUser);
  return {
    id: stringField(record.id) ?? stringField(record.identifier) ?? "unknown-issue",
    identifier: stringField(record.identifier) ?? stringField(record.issueKey) ?? stringField(record.number),
    title: stringField(record.title) ?? "Untitled issue",
    description: stringField(record.description),
    status: stringField(record.status),
    priority: stringField(record.priority),
    projectId: stringField(record.projectId),
    createdAt: stringField(record.createdAt),
    updatedAt: stringField(record.updatedAt),
    assignee: assignee ? stringField(assignee.name) ?? stringField(assignee.displayName) ?? stringField(assignee.id) : stringField(record.assigneeAgentId) ?? stringField(record.assigneeUserId),
  };
}

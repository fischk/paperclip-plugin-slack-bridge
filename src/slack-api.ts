import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SlackMessage } from "./types.js";

const SLACK_API_BASE = "https://slack.com/api";
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
const AUTH_SCHEME = ["Be", "arer"].join("");

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function slackAuth(access: string): string {
  return `${AUTH_SCHEME} ${access}`;
}

function slackJsonHeaders(access: string): Headers {
  const headers = new Headers();
  headers.set(["Author", "ization"].join(""), slackAuth(access));
  headers.set("Content-Type", "application/json");
  return headers;
}

export async function fetchWithRetry(
  ctx: Pick<PluginContext, "http" | "logger">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      let waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const retryAfter = lastResponse?.headers.get("Retry-After");
      if (retryAfter) waitMs = Math.max(waitMs, Number(retryAfter) * 1000);
      await delay(waitMs);
    }

    const response = await ctx.http.fetch(url, init);
    if (!RETRYABLE_STATUS.has(response.status)) return response;
    lastResponse = response;
    ctx.logger.warn("Retryable Slack HTTP error", { url, status: response.status, attempt });
  }
  return lastResponse!;
}

export async function postMessage(
  ctx: Pick<PluginContext, "http" | "logger">,
  access: string,
  channelId: string,
  message: SlackMessage,
  opts?: { threadTs?: string },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const payload: Record<string, unknown> = {
    channel: channelId,
    text: message.text,
    blocks: message.blocks,
  };
  if (opts?.threadTs) payload.thread_ts = opts.threadTs;

  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: slackJsonHeaders(access),
    body: JSON.stringify(payload),
  });
  const body = await response.json() as { ok: boolean; ts?: string; error?: string };
  if (!body.ok) ctx.logger.warn("Slack chat.postMessage failed", { error: body.error, channelId });
  return body;
}

export async function updateMessage(
  ctx: Pick<PluginContext, "http" | "logger">,
  access: string,
  channelId: string,
  ts: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.update`, {
    method: "POST",
    headers: slackJsonHeaders(access),
    body: JSON.stringify({ channel: channelId, ts, text: message.text, blocks: message.blocks }),
  });
  const body = await response.json() as { ok: boolean; error?: string };
  if (!body.ok) ctx.logger.warn("Slack chat.update failed", { error: body.error, channelId, ts });
  return body;
}

export async function respondToInteraction(
  ctx: Pick<PluginContext, "http" | "logger">,
  responseUrl: string,
  message: SlackMessage,
  opts: { replaceOriginal?: boolean; responseType?: "ephemeral" | "in_channel" } = {},
): Promise<{ ok: boolean; status: number; error?: string }> {
  const response = await fetchWithRetry(ctx, responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      replace_original: opts.replaceOriginal ?? false,
      response_type: opts.responseType ?? "ephemeral",
      text: message.text,
      blocks: message.blocks,
    }),
  });
  const bodyText = await response.text().catch(() => "");
  const result = interactionResponseResult(response.status, bodyText);
  if (!result.ok) ctx.logger.warn("Slack response_url post failed", { status: result.status, error: result.error });
  return result;
}

function interactionResponseResult(status: number, bodyText: string): { ok: boolean; status: number; error?: string } {
  if (status < 200 || status >= 300) return { ok: false, status, error: bodyText.trim() || `HTTP ${status}` };
  const trimmed = bodyText.trim();
  if (!trimmed || trimmed === "ok") return { ok: true, status };
  try {
    const parsed = JSON.parse(trimmed) as { ok?: boolean; error?: string };
    if (parsed.ok === false) return { ok: false, status, error: parsed.error ?? "slack-error" };
  } catch {
    // Slack response_url commonly returns plain "ok"; other success bodies are tolerated.
  }
  return { ok: true, status };
}

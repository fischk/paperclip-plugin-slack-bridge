import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { ACTION_IDS } from "./constants.js";
import { classifyHostError } from "./host-errors.js";
import { respondToInteraction } from "./slack-api.js";
import { renderInteractionAck } from "./slack-control.js";
import type { SlackNotificationsConfig } from "./types.js";
import { approvalActionRoute, handleApprovalAction } from "./socket/approval-actions.js";
import { handleSlackEvent, handleSlashCommand } from "./socket/commands.js";
import { handleInteractionAnswerAction, handleInteractionConfirmationAction, handleInteractionSubmitAction } from "./socket/interaction-actions.js";
import { firstAction, isDuplicateInteraction } from "./socket/slack-state.js";
import type { SlackActionResponse, SlackActionResult, SocketContext, SocketEnvelope, SocketModeRuntime } from "./socket/types.js";
import { stringField } from "./socket/utils.js";

export type { SocketModeRuntime } from "./socket/types.js";

const QUIET_LINK_ACTION_IDS = new Set<string>([
  ACTION_IDS.approvalOpen,
  ACTION_IDS.issueOpen,
  ACTION_IDS.runOpen,
  ACTION_IDS.paperclipHomeOpen,
]);

export async function startSlackSocketMode(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  botToken: string,
  appToken: string,
): Promise<SocketModeRuntime> {
  const client = new SocketModeClient({ appToken, logLevel: LogLevel.WARN, autoReconnectEnabled: true });
  let connected = false;

  client.on("connected", () => {
    connected = true;
    ctx.logger.info("Slack Socket Mode connected");
  });
  client.on("disconnected", (error?: Error) => {
    connected = false;
    if (error) ctx.logger.warn("Slack Socket Mode disconnected with error", { error: error.message });
    else ctx.logger.info("Slack Socket Mode disconnected");
  });
  client.on("error", (error: Error) => {
    ctx.logger.error("Slack Socket Mode error", { error: error.message });
  });

  const processEnvelope = async (envelope: SocketEnvelope) => {
    try {
      await envelope.ack?.();
    } catch (error) {
      ctx.logger.warn("Slack Socket Mode ack failed", { error: error instanceof Error ? error.message : String(error) });
    }

    try {
      await handleSocketEnvelope(ctx, config, botToken, envelope);
    } catch (error) {
      const errorKind = classifyHostError(error);
      ctx.logger.error("Slack Socket Mode envelope handler failed", { error_kind: errorKind, error: error instanceof Error ? error.message : String(error), type: envelope.type });
      void ctx.metrics.write("slack_socket_envelope_failed", 1, { type: envelope.type ?? "unknown", error_kind: errorKind }).catch((metricsError: unknown) => {
        ctx.logger.warn("Failed to write Slack Socket Mode envelope failure metric", { error: metricsError instanceof Error ? metricsError.message : String(metricsError) });
      });
    }
  };

  client.on("slack_event", processEnvelope);
  client.on("slash_commands", processEnvelope);
  client.on("interactive", processEnvelope);
  client.on("block_actions", processEnvelope);

  await client.start();
  return {
    get connected() {
      return connected;
    },
    async stop() {
      await client.disconnect();
    },
  };
}

async function handleSocketEnvelope(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  botToken: string,
  envelope: SocketEnvelope,
): Promise<void> {
  const body = envelope.body ?? {};
  const event = (body.event as Record<string, unknown> | undefined) ?? envelope.event;
  const type = envelope.type ?? String(body.type ?? event?.type ?? "unknown");

  await ctx.metrics.write("slack_socket_envelope_seen", 1, { type });

  if (type === "events_api" && event) {
    await handleSlackEvent(ctx, config, botToken, event);
    return;
  }

  if (type === "slash_commands") {
    await handleSlashCommand(ctx, config, botToken, body);
    return;
  }

  if (type === "interactive" || type === "block_actions") {
    await handleInteractive(ctx, config, body);
    return;
  }

  ctx.logger.debug("Ignored Slack Socket Mode envelope", { type });
}

async function handleInteractive(
  ctx: SocketContext,
  config: SlackNotificationsConfig,
  body: Record<string, unknown>,
): Promise<void> {
  const action = firstAction(body);
  const actionId = action?.action_id ?? "unknown";
  const responseUrl = stringField(body.response_url);

  if (isDuplicateInteraction(body, action)) {
    ctx.logger.debug("Ignored duplicate Slack interaction", { actionId });
    await ctx.metrics.write("slack_socket_interaction_duplicate", 1, { actionId });
    return;
  }

  if (QUIET_LINK_ACTION_IDS.has(actionId)) {
    await ctx.metrics.write("slack_socket_interaction_acknowledged", 1, { actionId, quiet: "true" });
    return;
  }

  let result: SlackActionResult;
  let handledKnownAction = false;
  if (approvalActionRoute(actionId)) {
    handledKnownAction = true;
    result = await handleApprovalAction(ctx, config, actionId, action?.value);
  } else if (actionId === ACTION_IDS.interactionCheckboxSelect || actionId === ACTION_IDS.suggestedTasksSelect) {
    handledKnownAction = true;
    result = null;
  } else if (actionId === ACTION_IDS.interactionSubmit) {
    handledKnownAction = true;
    result = await handleInteractionSubmitAction(ctx, config, body, action?.value);
  } else if (actionId === ACTION_IDS.interactionAccept || actionId === ACTION_IDS.interactionReject) {
    handledKnownAction = true;
    result = await handleInteractionConfirmationAction(ctx, config, body, actionId, action?.value);
  } else if (actionId.startsWith(ACTION_IDS.interactionAnswerOption)) {
    handledKnownAction = true;
    result = await handleInteractionAnswerAction(ctx, config, action?.value);
  }

  const response = normalizeActionResponse(result);
  if (response && responseUrl) await respondToInteraction(ctx, responseUrl, response.message, { replaceOriginal: response.replaceOriginal, responseType: response.responseType ?? "ephemeral" });
  else if (response) ctx.logger.info("Received Slack action without response_url", { actionId });
  else if (!handledKnownAction) {
    const fallback = renderInteractionAck(actionId, action?.value, config);
    if (responseUrl) await respondToInteraction(ctx, responseUrl, fallback, { responseType: "ephemeral" });
    else ctx.logger.info("Received Slack action without response_url", { actionId });
  }
  await ctx.metrics.write("slack_socket_interaction_acknowledged", 1, { actionId });
}

function normalizeActionResponse(result: SlackActionResult): SlackActionResponse | null {
  if (!result) return null;
  if ("message" in result) return result;
  return { message: result };
}

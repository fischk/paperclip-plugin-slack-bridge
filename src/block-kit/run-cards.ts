import { ACTION_IDS } from "../constants.js";
import type { NormalizedNotification, SlackMessage } from "../types.js";
import { actionBlock, contextFooter, fieldsBlock, linkButton, paperclipUrl, section } from "./common.js";
import { assertSlackMessageBounds, truncateText } from "./limits.js";

export function renderRunCard(notification: NormalizedNotification, baseUrl: string): SlackMessage {
  const runId = notification.runId ?? notification.entityId ?? notification.eventId;
  const url = notification.url ?? paperclipUrl(baseUrl, `/runs/${runId}`);
  const isFailure = notification.kind === "run.failed";
  const fields = fieldsBlock([
    ["Agent", notification.agentName],
    ["Issue", notification.identifier ?? notification.issueId],
    ["Project", notification.projectName],
    ["Status", notification.status],
  ]);
  const detail = isFailure ? notification.error : notification.summary;
  const blocks = [
    section(`${isFailure ? "*Run failed* :warning:" : "*Run finished* :white_check_mark:"}\n*${truncateText(notification.title, 220)}*${detail ? `\n\`\`\`${truncateText(detail, 900)}\`\`\`` : ""}`),
    ...(fields ? [fields] : []),
    actionBlock([linkButton("Open Run", url, ACTION_IDS.runOpen)]),
    contextFooter(notification),
  ];
  const message = { text: `${isFailure ? "Run failed" : "Run finished"}: ${notification.title}`, blocks };
  assertSlackMessageBounds(message);
  return message;
}

import { DEFAULT_PAPERCLIP_BASE_URL } from "../constants.js";
import { renderApprovalCard } from "./approval-cards.js";
import { renderIssueCard } from "./issue-cards.js";
import { renderRunCard } from "./run-cards.js";
import type { NormalizedNotification, SlackMessage, SlackNotificationsConfig } from "../types.js";

export function renderNotification(notification: NormalizedNotification, config: SlackNotificationsConfig): SlackMessage {
  const baseUrl = config.paperclipBaseUrl || DEFAULT_PAPERCLIP_BASE_URL;
  if (notification.kind === "approval.created" || notification.kind === "approval.decided") {
    return renderApprovalCard(notification, baseUrl);
  }
  if (notification.kind === "run.failed" || notification.kind === "run.finished") {
    return renderRunCard(notification, baseUrl);
  }
  return renderIssueCard(notification, baseUrl);
}

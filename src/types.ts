import type { PluginEvent } from "@paperclipai/plugin-sdk";

export interface SlackNotificationsConfig {
  /** Raw token fields are used while Paperclip plugin secret refs are disabled. */
  slackBotToken?: string;
  slackAppToken?: string;
  /** Future-compatible refs; current Paperclip rejects plugin secret refs in config. */
  slackBotTokenRef?: string;
  slackAppTokenRef?: string;
  defaultChannelId: string;
  defaultCompanyId?: string;
  operatorUserId?: string;
  approvalsChannelId?: string;
  errorsChannelId?: string;
  runsChannelId?: string;
  paperclipBaseUrl?: string;
  socketModeEnabled?: boolean;
  notifyIssueAssigned?: boolean;
  notifyIssueBlocked?: boolean;
  notifyApprovalCreated?: boolean;
  notifyRunFailed?: boolean;
  notifyRunFinished?: boolean;
  notifyIssueCompleted?: boolean;
  notifyHumanInputNeeded?: boolean;
  humanLoopPollEnabled?: boolean;
  paperclipApiToken?: string;
}

export interface RuntimeSlackCredentials {
  botToken: string;
  appToken?: string;
}

export interface InteractionQuestionOption {
  id: string;
  label: string;
}

export interface InteractionQuestion {
  id: string;
  prompt: string;
  helpText?: string;
  selectionMode: "single" | "multi";
  required?: boolean;
  options: InteractionQuestionOption[];
}

export interface InteractionConfirmation {
  prompt: string;
  detailsMarkdown?: string;
  acceptLabel?: string;
  rejectLabel?: string;
  rejectRequiresReason?: boolean;
}

export interface InteractionCheckboxConfirmation extends InteractionConfirmation {
  options: InteractionQuestionOption[];
  defaultSelectedOptionIds?: string[];
  minSelected?: number;
  maxSelected?: number | null;
}

export interface SuggestedTaskDraft {
  clientKey: string;
  title: string;
  description?: string;
  priority?: string;
  workMode?: string;
  parentClientKey?: string;
  hiddenInPreview?: boolean;
}

export interface InteractionSuggestedTasks {
  tasks: SuggestedTaskDraft[];
  defaultParentId?: string;
}

export type NotificationKind =
  | "approval.created"
  | "approval.decided"
  | "human.input_needed"
  | "issue.assigned"
  | "issue.blocked"
  | "issue.unblocked"
  | "issue.completed"
  | "run.failed"
  | "run.finished";

export interface NormalizedNotification {
  kind: NotificationKind;
  eventId: string;
  eventType: string;
  occurredAt: string;
  companyId: string;
  entityId?: string;
  issueId?: string;
  runId?: string;
  approvalId?: string;
  projectId?: string;
  agentId?: string;
  identifier?: string;
  title: string;
  description?: string;
  status?: string;
  previousStatus?: string;
  priority?: string;
  companyName?: string;
  companyPrefix?: string;
  projectName?: string;
  agentName?: string;
  assigneeName?: string;
  blockerIds?: string[];
  issueIds?: string[];
  interactionId?: string;
  interactionKind?: string;
  interactionTitle?: string;
  interactionSummary?: string;
  interactionConfirmation?: InteractionConfirmation;
  interactionCheckboxConfirmation?: InteractionCheckboxConfirmation;
  interactionSuggestedTasks?: InteractionSuggestedTasks;
  interactionQuestions?: InteractionQuestion[];
  attentionReason?: string;
  actionLabel?: string;
  approvalType?: string;
  approvalTitle?: string;
  recommendedAction?: string;
  risks?: string[];
  requestedByName?: string;
  decisionNote?: string;
  linkedIssues?: Array<{ id?: string; identifier?: string; title?: string }>;
  error?: string;
  summary?: string;
  url?: string;
  raw: PluginEvent;
}

export interface SlackTextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: Array<Record<string, unknown>>;
  accessory?: Record<string, unknown>;
  label?: SlackTextObject;
  element?: Record<string, unknown>;
  optional?: boolean;
  hint?: SlackTextObject;
}

export interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

export interface SlackThreadRef {
  channelId: string;
  threadTs: string;
  rootMessageTs?: string;
  lastCardTs?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Destination {
  channelId: string;
  threadTs?: string;
  reason: "linked-thread" | "per-type-channel" | "default-channel";
}

export interface DispatchResult {
  posted: boolean;
  reason: string;
  channelId?: string;
  ts?: string;
  threadTs?: string;
}

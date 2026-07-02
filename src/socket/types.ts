import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SlackMessage } from "../types.js";

// Socket Mode needs companies/issues/state plus logging/http/metrics. The concrete
// object passed from worker.ts is the full PluginContext; this narrower shape keeps
// command helpers honest while still allowing safe write commands.
export type SocketContext = Pick<PluginContext, "logger" | "http" | "metrics" | "companies" | "issues" | "state">;

export interface SocketModeRuntime {
  connected: boolean;
  stop(): Promise<void>;
}

export interface SocketEnvelope {
  ack?: (response?: unknown) => Promise<void>;
  type?: string;
  body?: Record<string, unknown>;
  event?: Record<string, unknown>;
  envelope_id?: string;
}

export interface SlackAction {
  action_id?: string;
  value?: string;
  type?: string;
  action_ts?: string;
}

export interface SlackActionResponse {
  message: SlackMessage;
  replaceOriginal?: boolean;
  responseType?: "ephemeral" | "in_channel";
}

export type SlackActionResult = SlackMessage | SlackActionResponse | null | undefined;

export interface IssueInteractionRef {
  issueId?: string;
  interactionId?: string;
}

export interface InteractionActionValue extends IssueInteractionRef {
  companyPrefix?: string;
  kind?: string;
  optionActionId?: string;
  minSelected?: number;
  maxSelected?: number | null;
  taskClientKeys: string[];
  taskParentClientKeys: Record<string, string>;
  defaultSelectedOptionIds: string[];
}

export interface CommandContext {
  channelId?: string;
  threadTs?: string;
  userId?: string;
  source: "slash" | "mention" | "assistant";
}

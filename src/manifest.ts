import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_PAPERCLIP_BASE_URL, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Bridge",
  description: "Deterministic Slack notifications and lightweight controls for Paperclip companies over Slack Socket Mode.",
  author: "Karl Fischer",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "events.subscribe",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  jobs: [
    {
      jobKey: "human-loop-poll",
      displayName: "Poll human-in-loop attention",
      description: "Scans Paperclip issues for pending board decisions or user questions when no direct plugin event exists.",
      schedule: "*/1 * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackBotToken: { type: "string", title: "Slack Bot User OAuth Token", description: "xoxb-... token. Stored in plugin config until plugin secret refs are re-enabled." },
      slackAppToken: { type: "string", title: "Slack Socket Mode App-Level Token", description: "xapp-... token with connections:write." },
      defaultChannelId: { type: "string", title: "Default Slack Channel ID" },
      defaultCompanyId: { type: "string", title: "Default Paperclip Company ID", description: "Optional company UUID to use when `/paperclip issues` has no company argument.", default: "" },
      operatorUserId: { type: "string", title: "Primary Slack Operator User ID", default: "" },
      approvalsChannelId: { type: "string", title: "Approvals Channel ID", default: "" },
      errorsChannelId: { type: "string", title: "Errors Channel ID", default: "" },
      runsChannelId: { type: "string", title: "Run Updates Channel ID", default: "" },
      paperclipBaseUrl: { type: "string", title: "Paperclip Base URL", default: DEFAULT_PAPERCLIP_BASE_URL },
      paperclipApiToken: { type: "string", title: "Optional Paperclip API Token", description: "Bearer token for approval action endpoints when the Paperclip API requires authenticated board access.", default: "" },
      socketModeEnabled: { type: "boolean", title: "Enable Slack Socket Mode ingress", default: true },
      humanLoopPollEnabled: { type: "boolean", title: "Poll for human-in-loop attention", default: true },
      notifyHumanInputNeeded: { type: "boolean", title: "Notify when an agent needs human input", default: true },
      notifyIssueAssigned: { type: "boolean", title: "Notify when issues are assigned/woken", default: false },
      notifyIssueBlocked: { type: "boolean", title: "Notify when issues are blocked/unblocked", default: false },
      notifyApprovalCreated: { type: "boolean", title: "Notify when approvals are requested", default: true },
      notifyRunFailed: { type: "boolean", title: "Notify when agent runs fail", default: false },
      notifyRunFinished: { type: "boolean", title: "Notify when agent runs finish", default: false },
      notifyIssueCompleted: { type: "boolean", title: "Notify when issues are completed", default: false },
    },
    required: ["slackBotToken", "defaultChannelId"],
  },
} satisfies PaperclipPluginManifestV1;

export default manifest;

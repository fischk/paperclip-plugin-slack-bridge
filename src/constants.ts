import pkg from "../package.json" with { type: "json" };

export const PLUGIN_ID = "paperclip-plugin-slack-bridge";
// Single source of truth: npm version (canary or stable) is the only bump needed.
export const PLUGIN_VERSION: string = pkg.version;
export const HUMAN_INPUT_EVENT_TYPE = `plugin.${PLUGIN_ID}.human_input_needed` as const;

export const ACTION_IDS = {
  approvalApprove: "pc.approval.approve.v1",
  approvalDeny: "pc.approval.deny.v1",
  approvalRequestRevision: "pc.approval.request_revision.v1",
  approvalOpen: "pc.approval.open.v1",
  issueOpen: "pc.issue.open.v1",
  runOpen: "pc.run.open.v1",
  paperclipHomeOpen: "pc.paperclip.home.open.v1",
  interactionAnswerOption: "pc.interaction.answer_option.v1",
  interactionOptionSelect: "pc.interaction.option_select.v1",
  interactionOtherText: "pc.interaction.other_text.v1",
  interactionSubmit: "pc.interaction.submit.v1",
  interactionAccept: "pc.interaction.accept.v1",
  interactionReject: "pc.interaction.reject.v1",
  interactionCheckboxSelect: "pc.interaction.checkbox_select.v1",
  suggestedTasksSelect: "pc.interaction.suggested_tasks_select.v1",
} as const;

export const STATE_NAMESPACES = {
  channels: "channels",
  threads: "threads",
  dedupe: "dedupe",
  actions: "actions",
} as const;

export const STATE_KEYS = {
  companyChannel: (companyId: string) => `company.${companyId}`,
  projectChannel: (projectId: string) => `project.${projectId}`,
  issueThread: (issueId: string) => `issue.${issueId}`,
  runThread: (runId: string) => `run.${runId}`,
  approvalThread: (approvalId: string) => `approval.${approvalId}`,
  eventDedupe: (eventKey: string) => `event.${eventKey}`,
  actionDedupe: (actionKey: string) => `action.${actionKey}`,
  actionToken: (token: string) => `token.${token}`,
} as const;

export const DEFAULT_PAPERCLIP_BASE_URL = "http://127.0.0.1:3100";

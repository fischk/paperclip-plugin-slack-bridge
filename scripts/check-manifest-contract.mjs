// Reproduces Paperclip core's plugin-loader manifest validation using the
// published @paperclipai/shared schema — the same zod schema the host runs —
// and validates the REST payloads this plugin sends against core's published
// request schemas. Used by CI (nightly-compat) to detect contract drift.
import { existsSync, readFileSync } from "node:fs";
import {
  pluginManifestV1Schema,
  PLUGIN_API_VERSION,
  resolveApprovalSchema,
  respondIssueThreadInteractionSchema,
  acceptIssueThreadInteractionSchema,
  rejectIssueThreadInteractionSchema,
  ISSUE_THREAD_INTERACTION_KINDS,
  APPROVAL_STATUSES,
} from "@paperclipai/shared";

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const entrypoints = pkg.paperclipPlugin ?? {};
for (const key of ["manifest", "worker"]) {
  const rel = entrypoints[key];
  if (!rel) fail(`package.json paperclipPlugin.${key} is missing`);
  else if (!existsSync(new URL(`../${rel}`, import.meta.url))) fail(`paperclipPlugin.${key} points at ${rel}, which does not exist (run npm run build first)`);
}
// The remaining checks need the built manifest — bail before a raw import crash buries the message above.
if (process.exitCode) process.exit(process.exitCode);

const { default: manifest } = await import(new URL(`../${entrypoints.manifest}`, import.meta.url));

const parsed = pluginManifestV1Schema.safeParse(manifest);
if (!parsed.success) fail(`manifest fails pluginManifestV1Schema:\n${JSON.stringify(parsed.error.issues, null, 2)}`);

if (manifest.apiVersion !== PLUGIN_API_VERSION) {
  fail(`manifest apiVersion ${manifest.apiVersion} !== core PLUGIN_API_VERSION ${PLUGIN_API_VERSION} — core bumped the plugin API`);
}

if (manifest.version !== pkg.version) {
  fail(`manifest version ${manifest.version} !== package.json version ${pkg.version} — stale dist/? PLUGIN_VERSION derives from package.json at build time — run npm run build`);
}

if (!pkg.name.startsWith("paperclip-plugin-")) {
  fail(`package name "${pkg.name}" lacks the paperclip-plugin- prefix required for npm discovery`);
}

// --- REST payload contract ---
// The exact request bodies this plugin sends (src/socket/approval-actions.ts,
// src/socket/interaction-actions.ts) validated against core's published request
// schemas, plus the enum values our cards branch on. Update BOTH sides together.
const restChecks = [
  ["approval decide body", resolveApprovalSchema, { decisionNote: "Resolved from Slack action pc.approval.approve.v1." }],
  ["interaction respond body (form)", respondIssueThreadInteractionSchema, {
    answers: [{ questionId: "q-1", optionIds: ["opt-1"] }],
    summaryMarkdown: "Answered from Slack",
  }],
  ["interaction accept body (bare)", acceptIssueThreadInteractionSchema, {}],
  ["interaction accept body (checkboxes)", acceptIssueThreadInteractionSchema, { selectedOptionIds: ["opt-1"] }],
  ["interaction accept body (suggested tasks)", acceptIssueThreadInteractionSchema, { selectedClientKeys: ["task-1"] }],
  ["interaction reject body", rejectIssueThreadInteractionSchema, { reason: "Rejected from Slack." }],
];
for (const [label, schema, payload] of restChecks) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) fail(`REST payload drift — ${label} no longer parses:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
}

const REQUIRED_INTERACTION_KINDS = ["ask_user_questions", "request_confirmation", "request_checkbox_confirmation", "suggest_tasks"];
for (const kind of REQUIRED_INTERACTION_KINDS) {
  if (!ISSUE_THREAD_INTERACTION_KINDS.includes(kind)) fail(`interaction kind "${kind}" (rendered by our cards) no longer exists in core`);
}
const REQUIRED_APPROVAL_STATUSES = ["pending", "approved", "rejected", "revision_requested"];
for (const status of REQUIRED_APPROVAL_STATUSES) {
  if (!APPROVAL_STATUSES.includes(status)) fail(`approval status "${status}" (we branch on it) no longer exists in core`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`✓ manifest "${manifest.id}"@${manifest.version} valid against @paperclipai/shared (plugin API v${PLUGIN_API_VERSION})`);
console.log(`✓ REST payloads (${restChecks.length}) and enums (${REQUIRED_INTERACTION_KINDS.length} kinds, ${REQUIRED_APPROVAL_STATUSES.length} statuses) match core's published request schemas`);

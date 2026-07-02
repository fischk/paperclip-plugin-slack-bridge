# Comparison: this plugin vs `paperclip-plugin-slack`

This document compares **`paperclip-plugin-slack-bridge`** (this repo, plugin id `paperclip-plugin-slack-bridge`, v0.1.0) against the previous-generation **[`paperclip-plugin-slack`](https://github.com/mvanhorn/paperclip-plugin-slack)** (npm `paperclip-plugin-slack`, v2.0.9). Audience: users of the old plugin deciding whether/how to switch, and contributors wanting context.

## TL;DR

`paperclip-plugin-slack` is a broad "Slack Chat OS": notifications, interactive approvals, HITL escalation, multi-agent threads, a media-to-task pipeline, custom `!commands`, and event watches. It cannot currently be activated on Paperclip core master: its two **required** credential fields (`slackTokenRef`, `slackSigningSecretRef`) are `format: "secret-ref"`, and Paperclip's Secrets Manager work ([paperclipai#5429](https://github.com/paperclipai/paperclip/pull/5429), 2026-05-09, PAP-2394) shipped a fail-closed kill switch on plugin secret-ref UUIDs pending company-scoped plugin config. Per the old plugin's own README, activation fails with `Plugin secret references are disabled until company-scoped plugin config lands` and config writes containing secret-ref UUIDs return HTTP 422; the documented workaround is pinning to a pre-#5429 Paperclip release. This plugin is a rebuild against the current runtime with a deliberately narrow first slice — human-in-the-loop Paperclip surfaces in Slack (approvals and agent requests for human input) — using Socket Mode ingress instead of inbound webhooks, plain plugin-config tokens until secret refs return, and deterministic versioned Block Kit renderers. It is notifications-*first*, not notifications-only (ADR-003).

## Side-by-side

| Dimension | `paperclip-plugin-slack` v2.0.9 (old) | `paperclip-plugin-slack-bridge` v0.1.0 (this repo) |
|---|---|---|
| Scope | Full Chat OS: notifications, interactive approvals, HITL escalation channel, multi-agent group threads (ACP), media→task pipeline, custom `!command` workflows, proactive event watches, daily digest | Notifications + HITL control: approval cards with Approve/Reject/Request-revision buttons, human-input-needed cards, read-only `/paperclip` commands; broader surfaces exist in code but default off |
| Ingress model | Inbound plugin webhooks (`webhooks.receive`): 3 declared endpoints (Slack Events API, slash command, interactivity) behind public Request URLs, verified with HMAC-SHA256 signing-secret checks | Slack **Socket Mode only** (outbound WebSocket via `xapp-` token). No Request URLs, no plugin webhook endpoints, no signing secret. Request-URL fallback intentionally not implemented |
| Credentials | Bot OAuth token + signing secret, both as **secret-ref UUIDs** (`slackTokenRef`, `slackSigningSecretRef`) resolved via `secrets.read-ref` | Bot token (`xoxb-`, required) + Socket Mode app-level token (`xapp-` with `connections:write`) as **plain plugin-config strings** — a documented stopgap until Paperclip re-enables plugin secret refs; optional `paperclipApiToken` for approval endpoints |
| Config fields | `slackTokenRef`, `slackSigningSecretRef`, `defaultChannelId`, per-type channels (approvals/errors/pipeline), 6 notify toggles, `enableDailyDigest`, 4 escalation settings, `maxAgentsPerThread`, `paperclipBaseUrl` | `slackBotToken`, `slackAppToken`, `defaultChannelId`, `defaultCompanyId`, `operatorUserId`, per-type channels (approvals/errors/runs), `socketModeEnabled`, `humanLoopPollEnabled`, 7 notify toggles (only approvals + human-input on by default), `paperclipBaseUrl`, `paperclipApiToken` |
| Paperclip capabilities | 20, incl. write-heavy: `issues.create`, `agents.invoke`, `agent.sessions.*`, `events.emit`, `secrets.read-ref`, `webhooks.receive`, `instance.settings.register`, `agent.tools.register` | 12, read-leaning plus two issue writes: `companies.read`, `projects.read`, `issues.read`, `issues.create`, `issues.wakeup`, `events.subscribe`, `jobs.schedule`, `plugin.state.read/write`, `http.outbound`, `activity.log.write`, `metrics.write` |
| Events subscribed | `issue.created`, `issue.updated`, `approval.created`, `agent.run.failed`, `agent.run.finished`, `agent.status_changed`, `cost_event.created`, plugin-to-plugin ACP/stream events, wildcard buffering for watches | `approval.created`, `approval.decided`, `agent.run.failed`, `agent.run.finished`, `issue.updated`, `issue.relations.updated`, `issue.assignment_wakeup_requested`; plus a scheduled poll of `blockedInboxAttention` for HITL states with no direct event |
| Scheduled jobs | `daily-digest` (9am), `check-escalation-timeouts` (1 min), `check-watches` (2 min) | `human-loop-poll` (1 min) — reconciliation for `pending_board_decision` / `pending_user_decision` |
| Slack API usage | Web API (`chat.postMessage`, `chat.update`, response URLs) outbound; Events API + slash commands + interactivity inbound over HTTP | Web API (`chat.postMessage`, `chat.update`) outbound; events, interactivity, and `/paperclip` commands inbound over one Socket Mode connection |
| Rendering | Rich Block Kit via a `formatters.ts` module (per-notification formatter functions) | **Deterministic Block Kit** (ADR-002): versioned, typed, pure renderers over normalized events; stable namespaced `action_id`s; snapshot/invariant tests; no model-generated layouts |
| Slash commands | `/clip` — status, agents, issues, approve, acp spawn/status/close, commands, watches, help | `/paperclip` — status, help, companies, issues, issue, create, wakeup |
| Agent tools | 8 registered tools (`escalate_to_human`, `handoff_to_agent`, `discuss_with_agent`, `process_media`, `register_command`, `register_watch`, `remove_watch`, `list_watch_templates`) | None yet |
| Install | `npm install paperclip-plugin-slack` or `POST /api/plugins/install` with the package name | Same: `POST /api/plugins/install` with `paperclip-plugin-slack-bridge`. Slack app created from the bundled Socket Mode manifest (`slack-app-manifest.socket-mode.{json,yaml}`) |

## If you used the old plugin

**What maps to what**

- Approval notifications with Approve/Reject buttons → still the core feature. Cards now render deterministically, buttons act through existing Paperclip approval API endpoints, and resolved cards are replaced with a read-only state so stale buttons disappear.
- `notifyOnIssueCreated` / `notifyOnIssueDone` / `notifyOnAgentError` etc. → `notifyIssueAssigned`, `notifyIssueCompleted`, `notifyRunFailed`, `notifyRunFinished`, `notifyIssueBlocked` — but most now **default off**; only approvals and human-input notifications are on by default.
- Per-type channel routing → kept: `approvalsChannelId`, `errorsChannelId`, and `runsChannelId` (replacing `pipelineChannelId`), falling back to `defaultChannelId`.
- `/clip status|agents|issues|approve|help` → `/paperclip status|companies|issues|issue|help` (read-only; approve happens via buttons rather than a slash command).
- `slackTokenRef` (secret UUID) → `slackBotToken` (raw `xoxb-` value in plugin config, for now).

**What has no equivalent yet** — see the next section.

**What's new**

- Socket Mode ingress: works against a Paperclip instance with no public URL; no signing secret or webhook exposure to manage.
- Human-input-needed cards: a scheduled poll detects `blockedInboxAttention` reasons (`pending_board_decision`, `pending_user_decision`) so agents waiting on a human surface in Slack even without a dedicated core event.
- New Slack app config: an **app-level token** (`xapp-`, `connections:write`) is required for ingress; a ready-made Slack app manifest is bundled.
- Issue detail cards (`/paperclip issue`), issue creation (`create`), and agent wakeup (`wakeup`). No manual thread linking; notification threading is automatic.
- Versioned Block Kit contract with snapshot tests, making card output reviewable and stable.

## What the old plugin did that this one doesn't (yet)

- HITL **escalation channel** (`escalate_to_human` tool, suggested-reply buttons, timeouts with default actions, customer-message queueing).
- Multi-agent group threads: agent spawning, @mention routing, handoffs, agent-to-agent discussion loops, session registry (`/clip acp ...`).
- Media-to-task pipeline (Whisper transcription, brief agent, `process_media` tool, `file_shared` handling).
- Custom `!command` workflows and runtime command registration.
- Proactive event watches with wildcard patterns and built-in templates.
- Daily activity digest and budget-threshold / cost-event notifications.
- Issue-created notifications and agent connected/onboarding-milestone notifications.
- Any registered agent tools at all.
- Approving via slash command (`/clip approve <id>`).

Per ADR-003, the architecture keeps seams (normalizers, notification policy, renderers, interaction handlers) open for these; they were deliberately excluded from the first slice rather than ruled out.

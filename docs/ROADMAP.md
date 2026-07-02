# Roadmap

## Shipped (v0.1.0)

- Deterministic Block Kit notification cards: approvals (on by default), human-input-needed (on), issue/run notifications (off by default).
- HITL approval loop: approve / reject / request-revision from Slack, with in-place card updates.
- Human-loop reconciliation poller for states Paperclip doesn't emit events for (`pending_board_decision`, `pending_user_decision`).
- Slack Socket Mode ingress: `/paperclip` + `/clip` commands, app mentions, Block Kit actions. No public URL required.
- Issue detail cards (`/paperclip issue`).
- Issue creation and agent wakeup from Slack (`/paperclip create`, `/paperclip wakeup`).
- CI: verify on PR, nightly compat matrix against SDK `latest`/`canary`, npm publish workflow.

## Next — blocked on Paperclip core, ready in code

- **Secret refs for tokens** — move `slackBotToken`/`slackAppToken` to `format: "secret-ref"` config once core re-enables plugin secret references (currently fail-closed pending company-scoped plugin config).

## Next — plugin work

1. **Ask-user-questions card flow**: render an agent's pending question as an interactive card and post the answer back.
2. **Scope trim**: reduce the Slack app manifest to the scopes actually exercised, now that live behavior is known.
3. **Follow/mute controls** per issue/company from Slack.

## Later

- Company status cards and digests.
- Richer company conversation flows (assistant threads).
- Slack App Home tab.
- Carefully scoped agent/company wakeup flows beyond single issues.

Ordering within each section is priority order. Anything in "Later" moves up when someone actually needs it.

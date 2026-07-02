# Paperclip Slack Bridge

[![CI](https://github.com/fischk/paperclip-plugin-slack-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/fischk/paperclip-plugin-slack-bridge/actions/workflows/ci.yml)
[![Nightly SDK compat](https://github.com/fischk/paperclip-plugin-slack-bridge/actions/workflows/nightly-compat.yml/badge.svg)](https://github.com/fischk/paperclip-plugin-slack-bridge/actions/workflows/nightly-compat.yml)
[![npm](https://img.shields.io/npm/v/paperclip-plugin-slack-bridge)](https://www.npmjs.com/package/paperclip-plugin-slack-bridge)

Get [Paperclip](https://github.com/paperclipai/paperclip) approvals and "an agent needs your input" requests as actionable cards in Slack — and answer them without leaving Slack.

- **Approval cards**: when a Paperclip board needs a decision, a card appears in your Slack channel with Approve / Reject / Request revision buttons.
- **Human-input cards**: when an agent is blocked waiting on a human, you get notified instead of finding out hours later.
- **`/paperclip` slash commands**: check status, list companies and issues, and open issue cards from Slack.
- **Optional notifications** (off by default): issue assigned/blocked/completed, agent run failed/finished.

Everything renders as deterministic [Block Kit](https://docs.slack.dev/block-kit/) cards — the same event always produces the same card.

## Where this works (and where it doesn't)

✅ **Works:**
- Any Paperclip instance that can reach the internet — including on your laptop, a home server, or behind NAT/firewalls. The plugin connects *out* to Slack (Socket Mode); **you do not need a public URL, domain, or reverse proxy**.
- Free and paid Slack workspaces.

❌ **Not supported:**
- HTTP webhooks from Slack (Event Subscriptions / Interactivity Request URLs). This plugin is Socket-Mode-only by design — no signing secret, no exposed endpoint.
- Multiple Slack workspaces from one plugin install (one workspace per install). Likewise **one Slack app per Paperclip instance** — sharing an app across instances splits button clicks randomly between them (Socket Mode load-balances connections).
- Air-gapped hosts with no outbound internet (the Socket Mode connection needs to reach Slack).

## Setup

You need three things: a Slack app (5 minutes, no coding), the plugin installed in Paperclip, and the tokens pasted into the plugin's settings.

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace, then paste the contents of [`slack-app-manifest.socket-mode.json`](./slack-app-manifest.socket-mode.json) (or the `.yaml` version).
3. Create the app, then on the app page:
   - **Install to Workspace** and copy the **Bot User OAuth Token** (starts with `xoxb-`).
   - Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope and copy it (starts with `xapp-`).
4. In Slack, create (or pick) a channel for notifications, invite the app (`/invite @Paperclip`), and copy the channel ID (channel → *View channel details* → the `C...` ID at the bottom).

### 2. Install the plugin in Paperclip

From the Paperclip UI: **Settings → Plugins → Install** and enter `paperclip-plugin-slack-bridge`. (Pre-release builds from every merge are on the `canary` dist-tag — install them via the API by adding `"version": "canary"` to the request below; the UI install field takes a package name only.)

Or via the API:

```bash
curl -X POST http://localhost:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-plugin-slack-bridge"}'
```

### 3. Configure it

In the plugin's settings in Paperclip, fill in:

| Setting | Required | What it is |
|---|---|---|
| Slack Bot User OAuth Token | ✅ | The `xoxb-...` token from step 1 |
| Slack Socket Mode App-Level Token | recommended | The `xapp-...` token — without it, buttons and slash commands are disabled (notifications still post) |
| Default Slack Channel ID | ✅ | The `C...` channel where cards go |
| Approvals / Errors / Runs Channel IDs | | Route specific card types to different channels |
| Default Paperclip Company ID | | Used when `/paperclip issues` is called without a company |
| Paperclip Base URL | | Defaults to your local instance |
| Optional Paperclip API Token | | Needed for approval buttons if your Paperclip API requires authenticated board access |
| Notify toggles | | Approval + human-input notifications default **on**; the rest default off |

> **Note on secrets:** Paperclip's plugin secret references are currently disabled upstream, so tokens are stored as plain plugin config values. Never commit them anywhere; treat the plugin config as sensitive.

Enable the plugin. Its health check reports `ok` once it has a bot token, and Socket Mode connects when the app-level token is present.

## Slash commands

| Command | What it does |
|---|---|
| `/paperclip status` | Connection/status card |
| `/paperclip companies` | List visible Paperclip companies |
| `/paperclip issues <company>` | Recent issues for a company |
| `/paperclip issue <key-or-id>` | Detailed issue card |
| `/paperclip help` | Command help |
| `/paperclip approvals` | Explains the approval workflow (approvals are decided via card buttons, not this command) |
| `/paperclip create <company> <title>` | Create an issue |
| `/paperclip wakeup <key-or-id>` | Wake an issue's agent (queue a run) |

`/clip` is an alias for `/paperclip`.

## Troubleshooting

- **Nothing posts to Slack** — check the bot token is set, the app is invited to the channel, and the plugin health status in Paperclip.
- **Cards post but buttons/commands do nothing** — the `xapp-` app-level token is missing or lacks `connections:write`; Socket Mode is what carries interactions.
- **`/paperclip` returns "dispatch_failed"** — the plugin worker isn't running or Socket Mode is disconnected; check plugin health.
- **Approval buttons fail** — set the Paperclip API token in config; the buttons call Paperclip's approval endpoints, which may require auth.

## Keeping up with Paperclip core

Paperclip core moves fast. A nightly CI job re-runs this plugin's full test suite and manifest validation against the **latest** and **canary** builds of the Paperclip plugin SDK:

- **`latest` red** → the published SDK already breaks this plugin; expect problems on new Paperclip installs until a fix lands.
- **`canary` red, `latest` green** → an incoming break; a fix should land before the next stable Paperclip release.

Failures automatically open a GitHub issue labeled `compat`. See [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) for exactly which contract surfaces are covered and which aren't.

## Development

```bash
git clone https://github.com/fischk/paperclip-plugin-slack-bridge.git
cd paperclip-plugin-slack-bridge
npm ci
npm run verify   # typecheck + tests + build
```

For local runs without Paperclip config, the worker also accepts `PAPERCLIP_SLACK_BOT_TOKEN`, `PAPERCLIP_SLACK_APP_TOKEN`, `PAPERCLIP_API_TOKEN`, and `PAPERCLIP_SLACK_DEFAULT_CHANNEL_ID` environment variables as fallbacks. Values stored in plugin config always win; masked config echoes (`***`) are treated as absent so a real credential further down the chain still resolves.

### Documentation map

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — control planes, interfaces, and diagrams
- [`docs/COMPARISON.md`](./docs/COMPARISON.md) — differences from the older [`paperclip-plugin-slack`](https://github.com/mvanhorn/paperclip-plugin-slack)
- [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) — the Paperclip core contract surface and how breakage is detected
- [`docs/RELEASING.md`](./docs/RELEASING.md) — release process and live smoke test
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — what's next
- [`docs/SLACK_APP_SETUP.md`](./docs/SLACK_APP_SETUP.md) — Slack app details, scopes, and token notes
- [`docs/decisions/`](./docs/decisions/) — architecture decision records

## Contributing

Issues and PRs welcome. Run `npm run verify` before submitting; the CI gate is the same command.

## License

[MIT](./LICENSE)

# Slack App Setup

## Manifest

Use either:

`slack-app-manifest.socket-mode.json`

or:

`slack-app-manifest.socket-mode.yaml`

Import it at:

https://api.slack.com/apps → **Create New App** → **From an app manifest**

## Intended architecture

We use **Socket Mode only** for Slack ingress:

```text
Slack Socket Mode events/interactions/commands
  → Paperclip Slack plugin worker
  → deterministic routing/action handlers
  → Paperclip APIs/state
```

Paperclip → Slack outbound notifications use the Slack Web API (`chat.postMessage`, later `chat.update`).

There is intentionally **no request URL fallback**:

- no Event Subscriptions Request URL
- no Interactivity Request URL
- no plugin webhook endpoint for Slack payloads
- no Slack Signing Secret requirement

## Current commands

- `/paperclip status` — Socket Mode connection/status card, enriched with a small visible-company summary when the Paperclip SDK allows it.
- `/paperclip companies` — read-only list of visible Paperclip companies.
- `/paperclip issues <company>` — read-only recent issue list for a company prefix/name/id. If `defaultCompanyId` is configured, `/paperclip issues` can use it.
- `/paperclip issue <key-or-id>` — detailed issue card.
- `/paperclip help` — command help and current write posture.
- `/paperclip create <company> <title>` — creates a Paperclip issue (`issues.create` capability, granted at install).
- `/paperclip wakeup <key-or-id>` — queues an agent run for an issue (`issues.wakeup` capability, granted at install).

Approval Approve/Reject/Request revision buttons are handled over Socket Mode. Successful or already-resolved decisions replace the original Slack card with a read-only approval state so stale buttons are removed; unexpected failures still surface an ephemeral error with a Paperclip link.

## Tokens/config needed after app creation

Store these in Paperclip plugin config for now. Do not commit them.

> Current Paperclip caveat: plugin secret refs are disabled until company-scoped plugin config lands, so the live local setup uses raw plugin config values. Keep the repo clean and do not write credentials into files.

1. **Bot User OAuth Token**
   - Starts with `xoxb-...`
   - Used for `chat.postMessage`, `chat.update`, etc.

2. **App-Level Token**
   - Starts with `xapp-...`
   - Must have `connections:write`.
   - Needed for Socket Mode connection.

3. **Default test channel ID**
   - Starts with `C...` for public/private channel IDs often `C...` depending Slack.
   - Use a dedicated test channel first.

## Scope philosophy

The manifest is intentionally generous because the project vision is broader than notifications only. First implementation uses a small subset:

- `chat:write`
- `chat:write.public` depending channel install/invite behavior
- Socket Mode interactivity for Block Kit buttons

The manifest also includes forward-looking scopes:

- `assistant:write` and assistant thread events for future Slack assistant/company conversation flows
- `commands` for `/paperclip` and `/clip`
- `app_mentions:read` and message events for thread/company conversation flows
- `files:read` and `files:write` for media-to-task or artifact ingestion
- `im:write` for future DM replies
- user/channel read scopes for routing and identity mapping
- reactions for lightweight ack/status UX

We can trim scopes later once live behavior is known.

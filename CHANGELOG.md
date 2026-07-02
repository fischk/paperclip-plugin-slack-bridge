# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-01

Initial public release.

### Added
- Paperclip event notifications rendered as deterministic Slack Block Kit cards
  (`approval.created`, `approval.decided`, agent run failures/finishes, issue updates —
  each individually toggleable in plugin config).
- Human-in-the-loop approval flow: approve/reject Paperclip approvals directly from Slack.
- Human-input-needed polling: agents waiting on a human surface as Slack cards.
- `/paperclip` (and `/clip`) slash commands: status, companies, issues, issue detail, issue creation (`issues.create`), and agent wakeup (`issues.wakeup`).
- Slack Socket Mode ingress only — no public URL, webhooks, or signing secret required.
- Slack app manifests (`slack-app-manifest.socket-mode.{json,yaml}`) for one-click app creation.

# ADR-003 — Notifications First, Not Notifications Only

## Status

Accepted.

## Context

The initial plan risked narrowing the project too much around notifications. The maintainer clarified that notifications should work first, but not the total scope.

## Decision

Sequence implementation around the Paperclip → Slack notification/control loop first, while preserving the broader roadmap for Slack as a company interface.

## Consequences

- The first implementation slice avoids broad Chat OS features.
- Docs and architecture should not block future slash commands, thread linking, or company conversation flows.
- Package naming should emphasize Slack/Paperclip integration without implying the plugin is permanently notification-only.
- Near-term code should keep clean seams: event normalizers, notification policy, Block Kit renderers, Slack API, interaction handlers.

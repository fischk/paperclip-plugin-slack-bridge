# ADR-001 — Slack as Paperclip Control Surface

## Status

Accepted for initial design.

## Context

The old reference plugin describes a broad “Slack Chat OS.” The maintainer wants the broader ability to use Slack as an interface to Paperclip companies, but the first useful thing is seeing and acting on Paperclip company activity from Slack.

## Decision

Design Slack as an operator control surface for Paperclip companies.

Slack messages should represent Paperclip state and safe actions. Paperclip remains the system of record.

## Consequences

- Paperclip entities drive Slack UI.
- Slack threads can link to issues/runs/approvals.
- Notifications come before general chat or command creation.
- Interactive actions must map to explicit Paperclip commands.
- The website remains canonical for deep inspection.

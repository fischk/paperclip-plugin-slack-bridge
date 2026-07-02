# ADR-002 — Deterministic Block Kit Rendering

## Status

Accepted for initial design.

## Context

The maintainer specifically wants a deterministic, consistent system and wants Slack Block Kit leveraged for interactive responses.

## Decision

All Slack UI emitted by this plugin will come from versioned, typed Block Kit renderers.

No model-generated Block Kit layouts.

## Consequences

- Renderers are pure functions over normalized Paperclip event/state.
- Every card has a version.
- Every action has a stable namespaced `action_id`.
- Snapshot tests and invariant tests become required.
- Agent text can be included only in bounded content fields.

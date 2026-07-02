# Compatibility with Paperclip Core

Paperclip core releases frequently and does not guarantee plugin-contract stability. This doc lists every surface where this plugin touches core, how drift is detected, and — importantly — what the automation **cannot** catch.

## Contract surfaces

| Surface | Where we use it | Breaks when core changes… |
|---|---|---|
| `definePlugin` lifecycle (`setup`, `onConfigChanged`, `onValidateConfig`, `onHealth`, `onShutdown`) | `src/worker.ts` | hook signatures or call semantics |
| `PluginContext` clients: `ctx.events`, `ctx.jobs`, `ctx.config`, `ctx.secrets`, `ctx.state`, `ctx.issues`, `ctx.companies`, `ctx.metrics`, `ctx.logger` | throughout `src/` | client method shapes or behavior |
| Manifest schema (`PaperclipPluginManifestV1`) + `apiVersion` | `src/manifest.ts` | schema fields, capability names, `PLUGIN_API_VERSION` bump |
| Event names (`approval.created`, `approval.decided`, `agent.run.*`, `issue.*`) | `src/worker.ts` subscriptions | `PluginEventType` renames/removals |
| Worker RPC protocol (`runWorker`, host↔worker framing) | build-time (SDK bundled into `dist/worker.js`) | protocol revisions in core's worker manager |
| Paperclip HTTP API (approvals, issues, companies) via direct `fetch` | `src/human-loop-poller.ts`, approval actions | REST endpoint paths/shapes; these are **not** part of the plugin SDK contract |
| npm discovery convention (`paperclip-plugin-*` name prefix, `paperclipPlugin` package.json block) | `package.json` | loader discovery rules |

## How drift is detected

The nightly CI job (`.github/workflows/nightly-compat.yml`) installs `@paperclipai/plugin-sdk` and `@paperclipai/shared` from both the `latest` and `canary` npm dist-tags, then runs:

1. `npm run verify` — strict typecheck against the new SDK types, all unit tests, and an esbuild build (which bundles the SDK runtime, so removed exports fail here).
2. `tests/sdk-harness.spec.ts` — boots the real plugin definition against the SDK's own `createTestHarness` fake host. Because the harness ships with each SDK version, runtime lifecycle/ctx drift fails here even when types still line up.
3. `scripts/check-manifest-contract.mjs` — validates the built manifest against `pluginManifestV1Schema` from `@paperclipai/shared` (the exact schema core's plugin loader runs) and asserts `apiVersion === PLUGIN_API_VERSION`.

Failures open/refresh a GitHub issue labeled `compat`. Read the matrix like this:

| latest | canary | Meaning |
|---|---|---|
| ✅ | ✅ | Compatible with current and next core |
| ✅ | ❌ | **Incoming break** — fix before the next stable core release |
| ❌ | — | **Broken now** for anyone installing against current core |

## Known gaps — what the nightly will NOT catch

1. **Host-side runtime behavior drift.** Semantics of `ctx.state` scoping, event delivery/ordering, job scheduling, or config/secret resolution can change without any type change. The harness catches some of this; a real core server catches more. Manual check: install into a current Paperclip instance and run the smoke test in [`RELEASING.md`](./RELEASING.md).
2. **Worker wire-protocol changes.** The SDK is *inlined* into `dist/worker.js` at build time. A host that requires newer inlined SDK behavior only fails at real install/activation, not in CI.
3. **Capability enforcement tightening.** A schema-valid manifest can still be denied at runtime — e.g. if core changes egress policy for `http.outbound` (the Socket Mode WebSocket depends on it).
4. **Loader conventions beyond the schema.** Discovery prefix, reserved route segments, and capability-consistency checks live in core's server code, not the published schema.
5. **Paperclip REST API drift — partially covered.** The human-loop poller and approval buttons call core's HTTP API directly (loopback URLs are blocked through `ctx.http.fetch`, so this is unavoidable). These endpoints are not versioned for plugins. Coverage now in place:
   - **Request-body and enum drift**: the nightly contract script validates the exact payloads we send against core's published request schemas (`resolveApprovalSchema`, `respondIssueThreadInteractionSchema`, accept/reject schemas) and asserts the interaction kinds / approval statuses we branch on still exist.
   - **Runtime behavior drift**: a health canary — when every REST read fails for 3+ consecutive poll cycles, plugin health degrades with a "possible Paperclip REST API drift" message instead of decaying silently.
   - **Still uncovered**: URL path renames and response-shape changes (core doesn't publish most response schemas). A running instance's `GET /api/openapi.json` describes all paths — diff the plugin-relevant subset during the release smoke if paths are suspected.
6. **Slack API drift.** No live Slack in CI by design; Block Kit or Socket Mode changes surface only in production.

## When a core release lands

Quick manual checklist (5 minutes):

1. Check the nightly badge / `compat` issues.
2. `POST /api/plugins/install` still finds and activates the plugin; health reports `ok`.
3. One approval round-trip: create an approval in Paperclip → card in Slack → click Approve → card updates and the approval resolves in Paperclip.
4. `/paperclip status` responds.

If (3) fails while (2) passes, suspect the REST API surface (gap 5), not the SDK.

// Boots the real plugin definition against the SDK's own fake host.
// Because the harness ships inside @paperclipai/plugin-sdk, the nightly compat
// job re-runs this against SDK@latest/@canary — lifecycle or ctx-surface drift
// in core fails here, not just at the type level.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

// The human-loop poller fetches the local Paperclip API directly; stub it so
// this spec never touches a live instance (or hangs in CI). Env vars are stubbed
// empty because the worker treats SLACK_*/PAPERCLIP_* env vars as credential
// fallbacks — a dev shell with real tokens exported must not flip these tests.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })));
  for (const name of ["PAPERCLIP_SLACK_BOT_TOKEN", "PAPERCLIP_SLACK_APP_TOKEN", "PAPERCLIP_API_TOKEN", "PAPERCLIP_SLACK_DEFAULT_CHANNEL_ID"]) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ponytail: no Slack tokens on purpose — this exercises the SDK contract, not Slack
function boot(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config: { socketModeEnabled: false, ...config } });
  return harness;
}

describe("SDK harness smoke", () => {
  it("sets up against the fake host without config and degrades gracefully", async () => {
    const harness = boot();
    await plugin.definition.setup(harness.ctx);
    expect(harness.logs.some((l) => l.level === "warn")).toBe(true);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
  });

  it("validates config through the real lifecycle hook", async () => {
    const result = await plugin.definition.onValidateConfig?.({});
    expect(result?.ok).toBe(false);
    expect(result?.errors).toContain("Slack bot token is required.");

    const ok = await plugin.definition.onValidateConfig?.({
      slackBotToken: "xoxb-test-fake",
      defaultChannelId: "C0000000000",
    });
    expect(ok?.ok).toBe(true);
  });

  it("registers event subscriptions and the human-loop job with the host", async () => {
    const harness = boot({
      slackBotToken: "xoxb-test-fake",
      defaultChannelId: "C0000000000",
    });
    await plugin.definition.setup(harness.ctx);
    // job handler is registered; running it hits the (fake) host, and any
    // thrown error must come from our own logic, not a missing registration
    await expect(harness.runJob("human-loop-poll")).resolves.toBeUndefined();
  });
});

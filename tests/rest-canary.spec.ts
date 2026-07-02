import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { resetHostCallFailureSuppression } from "../src/host-errors.js";

const baseUrl = "http://127.0.0.1:3100";
const companiesUrl = `${baseUrl}/api/companies`;

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function boot() {
  return createTestHarness({
    manifest,
    config: {
      socketModeEnabled: false,
      slackBotToken: "xoxb-test-fake",
      defaultChannelId: "C0000000000",
    },
  });
}

function stubEnvFallbacks() {
  for (const name of ["PAPERCLIP_SLACK_BOT_TOKEN", "PAPERCLIP_SLACK_APP_TOKEN", "PAPERCLIP_API_TOKEN", "PAPERCLIP_SLACK_DEFAULT_CHANNEL_ID"]) {
    vi.stubEnv(name, "");
  }
}

function stubFetch(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  }));
}

async function runPolls(harness: TestHarness, count: number, catchFailures = false) {
  for (let index = 0; index < count; index += 1) {
    try {
      await harness.runJob("human-loop-poll");
    } catch (error) {
      if (!catchFailures) throw error;
    }
  }
}

describe.sequential("REST-drift health canary", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    stubEnvFallbacks();
    stubFetch(async () => jsonResponse([]));
    harness = boot();
    await plugin.definition.setup(harness.ctx);
  });

  beforeEach(() => {
    resetHostCallFailureSuppression();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("degrades after every company issue-list REST read fails for three cycles", async () => {
    stubFetch(async (url) => {
      if (url === companiesUrl) return jsonResponse([{ id: "company-1" }, { id: "company-2" }]);
      if (url.startsWith(`${baseUrl}/api/companies/`) && url.includes("/issues?")) {
        return jsonResponse({ error: "drift" }, { status: 500, statusText: "Internal Server Error" });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    await runPolls(harness, 3);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toContain("possible Paperclip REST API drift");
    expect(health?.details?.consecutivePollFailures).toBe(3);
  });

  it("resets back to ok after one successful quiet cycle", async () => {
    stubFetch(async (url) => {
      if (url === companiesUrl) return jsonResponse([]);
      throw new Error(`Unexpected fetch ${url}`);
    });

    await harness.runJob("human-loop-poll");

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
    expect(health?.details?.consecutivePollFailures).toBe(0);
  });

  it("degrades after listCompanies rejects three times", async () => {
    stubFetch(async (url) => {
      if (url === companiesUrl) throw new Error("Paperclip API unreachable");
      throw new Error(`Unexpected fetch ${url}`);
    });

    await runPolls(harness, 3, true);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toContain("possible Paperclip REST API drift");
    expect(health?.details?.consecutivePollFailures).toBe(3);
  });

  it("does not treat a zero-company poll as a failure", async () => {
    stubFetch(async (url) => {
      if (url === companiesUrl) return jsonResponse([]);
      throw new Error(`Unexpected fetch ${url}`);
    });

    await harness.runJob("human-loop-poll");

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
    expect(health?.details?.consecutivePollFailures).toBe(0);
  });

  it("attributes repeated poll metric failures to SDK RPC denial instead of REST drift", async () => {
    const sdkHarness = boot();
    const originalMetricsWrite = sdkHarness.ctx.metrics.write;
    let metricDenials = 0;
    sdkHarness.ctx.metrics.write = vi.fn(async (name: string, value: number, tags?: Record<string, string>) => {
      if (name !== "slack_host_call_failed") {
        metricDenials += 1;
        throw new Error('Plugin "plugin-1" is not allowed to perform "metrics.write": the worker referenced a missing, expired, or unknown invocation scope');
      }
      return originalMetricsWrite(name, value, tags);
    });
    await plugin.definition.setup(sdkHarness.ctx);
    stubFetch(async (url) => {
      if (url === companiesUrl) return jsonResponse([{ id: "company-1" }]);
      if (url.startsWith(`${baseUrl}/api/companies/`) && url.includes("/issues?")) return jsonResponse([]);
      throw new Error(`Unexpected fetch ${url}`);
    });

    await runPolls(sdkHarness, 3, true);

    expect(metricDenials).toBe(3);
    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toContain("SDK RPC scope denial");
    expect(health?.message).not.toContain("possible Paperclip REST API drift");
    expect(health?.details?.consecutivePollFailures).toBe(3);
    expect(health?.details?.lastPollFailureSource).toBe("sdk-rpc");
    expect(health?.details?.lastPollErrorKind).toBe("scope-denied");
  });

  it("clears stale REST canary failures when config changes", async () => {
    stubFetch(async (url) => {
      if (url === companiesUrl) throw new Error("Paperclip API unreachable");
      throw new Error(`Unexpected fetch ${url}`);
    });
    await runPolls(harness, 3, true);
    expect((await plugin.definition.onHealth?.())?.status).toBe("degraded");

    await plugin.definition.onConfigChanged?.({
      socketModeEnabled: false,
      slackBotToken: "xoxb-test-fake",
      defaultChannelId: "C0000000000",
    });

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
    expect(health?.details?.consecutivePollFailures).toBe(0);
  });
});

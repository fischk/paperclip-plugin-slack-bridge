import { afterEach, describe, expect, it, vi } from "vitest";
import { recordHostCallFailure, resetHostCallFailureSuppression } from "../src/host-errors.js";

function ctx() {
  return {
    metrics: { write: vi.fn(async () => undefined) },
    logger: { warn: vi.fn() },
  } as any;
}

const scopeDenied = new Error('Plugin "plugin-1" is not allowed to perform "state.get": the worker referenced a missing, expired, or unknown invocation scope');
const capabilityDenied = new Error('Plugin "plugin-1" is missing required capability "issues.wakeup" for method "issues.requestWakeup"');

describe("recordHostCallFailure", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetHostCallFailureSuppression();
  });

  it("suppresses repeated writes for the same key within the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const context = ctx();

    expect(recordHostCallFailure(context, "poller_dispatch", "state.get", scopeDenied)).toBe("scope-denied");
    expect(recordHostCallFailure(context, "poller_dispatch", "state.get", scopeDenied)).toBe("scope-denied");

    expect(context.metrics.write).toHaveBeenCalledTimes(1);
    expect(context.metrics.write).toHaveBeenCalledWith("slack_host_call_failed", 1, {
      surface: "poller_dispatch",
      method: "state.get",
      error_kind: "scope-denied",
    });
  });

  it("emits suppressed repeat counts when the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const context = ctx();

    recordHostCallFailure(context, "poller_dispatch", "state.get", scopeDenied);
    recordHostCallFailure(context, "poller_dispatch", "state.get", scopeDenied);
    vi.advanceTimersByTime(60_000);
    recordHostCallFailure(context, "poller_dispatch", "state.get", scopeDenied);

    expect(context.metrics.write).toHaveBeenCalledTimes(2);
    expect(context.metrics.write).toHaveBeenLastCalledWith("slack_host_call_failed", 1, {
      surface: "poller_dispatch",
      method: "state.get",
      error_kind: "scope-denied",
      suppressed: "1",
    });
  });

  it("emits different keys immediately", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const context = ctx();

    recordHostCallFailure(context, "poller_dispatch", "state.get", scopeDenied);
    recordHostCallFailure(context, "poller_dispatch", "state.set", scopeDenied);
    recordHostCallFailure(context, "poller_dispatch", "state.get", capabilityDenied);

    expect(context.metrics.write).toHaveBeenCalledTimes(3);
  });
});

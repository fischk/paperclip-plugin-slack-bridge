import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";

describe("manifest", () => {
  it("keeps package.json and PLUGIN_VERSION in sync", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares a Socket Mode only Slack notification plugin surface", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.capabilities).toContain("issues.read");
    expect(manifest.capabilities).toContain("issues.create");
    expect(manifest.capabilities).toContain("issues.wakeup");
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.capabilities).not.toContain("webhooks.receive");
    expect((manifest as { webhooks?: unknown }).webhooks).toBeUndefined();
  });
});

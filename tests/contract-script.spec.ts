import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = new URL("../dist/manifest.js", import.meta.url);

describe("manifest contract script", () => {
  it.skipIf(!existsSync(manifestPath))("validates built manifest and REST payload contracts", () => {
    const result = spawnSync(process.execPath, ["scripts/check-manifest-contract.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("REST payloads");
  });
});

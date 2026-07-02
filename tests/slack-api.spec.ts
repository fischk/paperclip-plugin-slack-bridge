import { describe, expect, it, vi } from "vitest";
import { respondToInteraction } from "../src/slack-api.js";
import type { SlackMessage } from "../src/types.js";

const message: SlackMessage = {
  text: "Resolved",
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "Resolved" } }],
};

describe("slack-api response_url helpers", () => {
  it("posts replace_original payloads to Slack response URLs", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const logger = { warn: vi.fn() };

    const result = await respondToInteraction(
      { http: { fetch }, logger } as any,
      "https://slack.example/response",
      message,
      { replaceOriginal: true, responseType: "in_channel" },
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.example/response",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          replace_original: true,
          response_type: "in_channel",
          text: message.text,
          blocks: message.blocks,
        }),
      }),
    );
  });

  it("logs and returns failed response_url posts", async () => {
    const fetch = vi.fn(async () => new Response("expired_url", { status: 410 }));
    const logger = { warn: vi.fn() };

    const result = await respondToInteraction(
      { http: { fetch }, logger } as any,
      "https://slack.example/expired-response",
      message,
      { replaceOriginal: true, responseType: "in_channel" },
    );

    expect(result).toEqual({ ok: false, status: 410, error: "expired_url" });
    expect(logger.warn).toHaveBeenCalledWith("Slack response_url post failed", { status: 410, error: "expired_url" });
  });

  it("treats Slack JSON ok:false bodies as failed even when HTTP is 200", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_payload" }), { status: 200 }));
    const logger = { warn: vi.fn() };

    const result = await respondToInteraction(
      { http: { fetch }, logger } as any,
      "https://slack.example/response",
      message,
    );

    expect(result).toEqual({ ok: false, status: 200, error: "invalid_payload" });
    expect(logger.warn).toHaveBeenCalledWith("Slack response_url post failed", { status: 200, error: "invalid_payload" });
  });
});

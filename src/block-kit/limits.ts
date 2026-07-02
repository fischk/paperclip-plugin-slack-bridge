import type { SlackBlock, SlackMessage } from "../types.js";

export const SLACK_SECTION_TEXT_LIMIT = 3000;
export const SLACK_MESSAGE_BLOCK_LIMIT = 50;

export function truncateText(value: unknown, max = 500): string {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function assertSlackMessageBounds(message: SlackMessage): void {
  if ((message.blocks?.length ?? 0) > SLACK_MESSAGE_BLOCK_LIMIT) {
    throw new Error(`Slack message has too many blocks: ${message.blocks?.length}`);
  }
  for (const block of message.blocks ?? []) {
    assertBlockBounds(block);
  }
}

function assertBlockBounds(block: SlackBlock): void {
  if (block.text?.text && block.text.text.length > SLACK_SECTION_TEXT_LIMIT) {
    throw new Error(`Slack block text exceeds ${SLACK_SECTION_TEXT_LIMIT} characters`);
  }
  for (const field of block.fields ?? []) {
    if (field.text.length > SLACK_SECTION_TEXT_LIMIT) {
      throw new Error(`Slack block field exceeds ${SLACK_SECTION_TEXT_LIMIT} characters`);
    }
  }
}

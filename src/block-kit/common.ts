import type { NormalizedNotification, SlackBlock } from "../types.js";
import { truncateText } from "./limits.js";

export function mrkdwn(text: string) {
  return { type: "mrkdwn" as const, text };
}

export function plainText(text: string) {
  return { type: "plain_text" as const, text, emoji: true };
}

export function section(text: string, accessory?: Record<string, unknown>): SlackBlock {
  return { type: "section", text: mrkdwn(truncateText(text, 2900)), ...(accessory ? { accessory } : {}) };
}

export function fieldsBlock(fields: Array<[string, unknown | undefined]>): SlackBlock | null {
  const rendered = fields
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([label, value]) => mrkdwn(`*${label}*\n${truncateText(value, 450)}`));
  if (rendered.length === 0) return null;
  return { type: "section", fields: rendered };
}

export function contextFooter(notification: NormalizedNotification): SlackBlock {
  const when = notification.occurredAt || new Date().toISOString();
  return {
    type: "context",
    elements: [mrkdwn(`Paperclip • ${notification.kind} • ${when}`)],
  };
}

export function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return {
    type: "button",
    text: plainText(text),
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

export function linkButton(text: string, url: string, actionId: string) {
  return {
    type: "button",
    text: plainText(text),
    url,
    action_id: actionId,
  };
}

export function paperclipUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function actionBlock(elements: Array<Record<string, unknown>>): SlackBlock {
  return { type: "actions", elements };
}

export function inputBlock(
  blockId: string,
  label: string,
  element: Record<string, unknown>,
  hint?: string,
  optional = true,
): SlackBlock {
  return {
    type: "input",
    block_id: blockId,
    label: plainText(truncateText(label, 2000)),
    element,
    optional,
    ...(hint ? { hint: plainText(truncateText(hint, 2000)) } : {}),
  };
}

function optionObjects(options: Array<{ id: string; label: string }>) {
  return options.slice(0, 10).map((option) => ({
    text: plainText(truncateText(option.label, 75)),
    value: option.id,
  }));
}

export function radioButtons(actionId: string, options: Array<{ id: string; label: string }>): Record<string, unknown> {
  return {
    type: "radio_buttons",
    action_id: actionId,
    options: optionObjects(options),
  };
}

export function checkboxes(actionId: string, options: Array<{ id: string; label: string }>, selectedOptionIds: string[] = []): Record<string, unknown> {
  const renderedOptions = optionObjects(options);
  const selected = new Set(selectedOptionIds);
  const initialOptions = renderedOptions.filter((option) => selected.has(String(option.value)));
  return {
    type: "checkboxes",
    action_id: actionId,
    options: renderedOptions,
    ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
  };
}

export function plainTextInput(actionId: string, placeholder: string, multiline = false): Record<string, unknown> {
  return {
    type: "plain_text_input",
    action_id: actionId,
    multiline,
    max_length: 3000,
    placeholder: plainText(truncateText(placeholder, 150)),
  };
}

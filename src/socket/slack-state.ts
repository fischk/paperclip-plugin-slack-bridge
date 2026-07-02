import type { SlackAction } from "./types.js";
import { recordField, stringField } from "./utils.js";

const recentInteractionKeys = new Map<string, number>();
const RECENT_INTERACTION_TTL_MS = 60_000;

export function selectedMultiValues(body: Record<string, unknown>, actionId: string, fallbackValues: string[] = []): string[] {
  const selected = selectedOptionIdsFromState(body, actionId, "multi");
  return selected.length > 0 ? selected : fallbackValues;
}

export function selectedOptionIdsFromState(body: Record<string, unknown>, actionId: string, selectionMode: "single" | "multi"): string[] {
  const element = stateElement(body, actionId);
  if (!element) return [];
  if (selectionMode === "multi") {
    const selected = element.selected_options;
    if (!Array.isArray(selected)) return [];
    return selected.map((option) => stringField(recordField(option)?.value)).filter((value): value is string => Boolean(value));
  }
  const selected = recordField(element.selected_option);
  const value = stringField(selected?.value);
  return value ? [value] : [];
}

export function stateElement(body: Record<string, unknown>, actionId: string): Record<string, unknown> | undefined {
  const state = recordField(body.state);
  const values = recordField(state?.values);
  if (!values) return undefined;
  for (const blockValue of Object.values(values)) {
    const block = recordField(blockValue);
    const element = recordField(block?.[actionId]);
    if (element) return element;
  }
  return undefined;
}

export function firstAction(body: Record<string, unknown>): SlackAction | undefined {
  const actions = body.actions;
  if (!Array.isArray(actions)) return undefined;
  const [first] = actions;
  return typeof first === "object" && first !== null ? first as SlackAction : undefined;
}

export function isDuplicateInteraction(body: Record<string, unknown>, action?: SlackAction): boolean {
  const actionId = action?.action_id ?? "unknown";
  const user = recordField(body.user);
  const container = recordField(body.container);
  const key = [
    stringField(body.trigger_id),
    action?.action_ts,
    stringField(user?.id),
    stringField(container?.message_ts),
    actionId,
    action?.value,
  ].filter(Boolean).join(":");
  if (!key) return false;
  const now = Date.now();
  for (const [existingKey, seenAt] of recentInteractionKeys) {
    if (now - seenAt > RECENT_INTERACTION_TTL_MS) recentInteractionKeys.delete(existingKey);
  }
  if (recentInteractionKeys.has(key)) return true;
  recentInteractionKeys.set(key, now);
  return false;
}

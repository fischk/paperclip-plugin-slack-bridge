import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, STATE_NAMESPACES } from "./constants.js";
import type { SlackThreadRef } from "./types.js";

export async function getIssueThread(ctx: Pick<PluginContext, "state">, issueId: string): Promise<SlackThreadRef | null> {
  const value = await ctx.state.get({
    scopeKind: "issue",
    scopeId: issueId,
    namespace: STATE_NAMESPACES.threads,
    stateKey: STATE_KEYS.issueThread(issueId),
  });
  return isThreadRef(value) ? value : null;
}

export async function setIssueThread(ctx: Pick<PluginContext, "state">, issueId: string, ref: SlackThreadRef): Promise<void> {
  await ctx.state.set(
    { scopeKind: "issue", scopeId: issueId, namespace: STATE_NAMESPACES.threads, stateKey: STATE_KEYS.issueThread(issueId) },
    ref,
  );
}

export async function hasSeenEvent(ctx: Pick<PluginContext, "state">, companyId: string, eventKey: string): Promise<boolean> {
  const value = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: STATE_NAMESPACES.dedupe,
    stateKey: STATE_KEYS.eventDedupe(eventKey),
  });
  return Boolean(value);
}

export async function markEventSeen(ctx: Pick<PluginContext, "state">, companyId: string, eventKey: string, effect: string): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACES.dedupe, stateKey: STATE_KEYS.eventDedupe(eventKey) },
    { seenAt: new Date().toISOString(), source: "paperclip", effect },
  );
}

function isThreadRef(value: unknown): value is SlackThreadRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SlackThreadRef>;
  return typeof candidate.channelId === "string" && typeof candidate.threadTs === "string";
}

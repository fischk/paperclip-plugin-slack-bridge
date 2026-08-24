import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, STATE_NAMESPACES } from "./constants.js";
import type { SlackMessageRef, SlackThreadRef } from "./types.js";

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

/**
 * The approval card's own message, so `approval.decided` can edit it in place.
 * Per-issue thread state is not a substitute: other notification kinds post into
 * the same thread, so `lastCardTs` is not reliably the approval card.
 *
 * Scoped by company because `approval` is not a plugin state scope kind.
 */
export async function getApprovalMessage(ctx: Pick<PluginContext, "state">, companyId: string, approvalId: string): Promise<SlackMessageRef | null> {
  const value = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: STATE_NAMESPACES.threads,
    stateKey: STATE_KEYS.approvalThread(approvalId),
  });
  return isMessageRef(value) ? value : null;
}

export async function setApprovalMessage(ctx: Pick<PluginContext, "state">, companyId: string, approvalId: string, ref: SlackMessageRef): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACES.threads, stateKey: STATE_KEYS.approvalThread(approvalId) },
    ref,
  );
}

/** Once the card is resolved the ref can never be useful again, so it is not kept. */
export async function clearApprovalMessage(ctx: Pick<PluginContext, "state">, companyId: string, approvalId: string): Promise<void> {
  await ctx.state.delete({
    scopeKind: "company",
    scopeId: companyId,
    namespace: STATE_NAMESPACES.threads,
    stateKey: STATE_KEYS.approvalThread(approvalId),
  });
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

function isMessageRef(value: unknown): value is SlackMessageRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SlackMessageRef>;
  return typeof candidate.channelId === "string" && typeof candidate.ts === "string";
}

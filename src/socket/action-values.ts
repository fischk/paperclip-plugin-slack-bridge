import type { InteractionActionValue } from "./types.js";
import { numberField, recordField, stringArrayField, stringField, stringRecordField } from "./utils.js";

export interface InteractionSubmitQuestion {
  id: string;
  selectionMode: "single" | "multi";
  required?: boolean;
  optionActionId: string;
  otherActionId: string;
}

export function parseInteractionSubmitValue(value?: string): {
  issueId?: string;
  interactionId?: string;
  companyPrefix?: string;
  questions: InteractionSubmitQuestion[];
} {
  if (!value) return { questions: [] };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    return {
      issueId: stringField(parsed.issueId),
      interactionId: stringField(parsed.interactionId),
      companyPrefix: stringField(parsed.companyPrefix),
      questions: questions.map((question): InteractionSubmitQuestion | null => {
        const record = recordField(question) ?? {};
        const id = stringField(record.id);
        const selectionMode = stringField(record.selectionMode);
        const optionActionId = stringField(record.optionActionId);
        const otherActionId = stringField(record.otherActionId);
        if (!id || (selectionMode !== "single" && selectionMode !== "multi") || !optionActionId || !otherActionId) return null;
        return {
          id,
          selectionMode,
          required: record.required === true,
          optionActionId,
          otherActionId,
        };
      }).filter((question): question is InteractionSubmitQuestion => question !== null),
    };
  } catch {
    return { questions: [] };
  }
}

export function parseInteractionActionValue(value?: string): InteractionActionValue {
  if (!value) return { defaultSelectedOptionIds: [], taskClientKeys: [], taskParentClientKeys: {} };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      issueId: stringField(parsed.issueId),
      interactionId: stringField(parsed.interactionId),
      companyPrefix: stringField(parsed.companyPrefix),
      kind: stringField(parsed.kind),
      optionActionId: stringField(parsed.optionActionId),
      minSelected: numberField(parsed.minSelected),
      maxSelected: parsed.maxSelected === null ? null : numberField(parsed.maxSelected),
      taskClientKeys: stringArrayField(parsed.taskClientKeys) ?? [],
      taskParentClientKeys: stringRecordField(parsed.taskParentClientKeys),
      defaultSelectedOptionIds: stringArrayField(parsed.defaultSelectedOptionIds) ?? [],
    };
  } catch {
    return { defaultSelectedOptionIds: [], taskClientKeys: [], taskParentClientKeys: {} };
  }
}

export function parseInteractionAnswerValue(value?: string): {
  issueId?: string;
  interactionId?: string;
  questionId?: string;
  optionId?: string;
  optionLabel?: string;
  companyPrefix?: string;
} {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      issueId: stringField(parsed.issueId),
      interactionId: stringField(parsed.interactionId),
      questionId: stringField(parsed.questionId),
      optionId: stringField(parsed.optionId),
      optionLabel: stringField(parsed.optionLabel),
      companyPrefix: stringField(parsed.companyPrefix),
    };
  } catch {
    return {};
  }
}

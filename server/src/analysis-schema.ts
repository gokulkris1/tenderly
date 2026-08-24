import { createHash } from "node:crypto";
import type { BidAnswer, TenderAnalysis } from "./types.js";

/**
 * Version of the shape stored in `tenders.analysis`.
 *
 * Bump this whenever the payload changes in a way older readers cannot handle.
 * A tender whose stored analysis carries an older version still renders; the UI
 * invites the user to re-analyse rather than failing.
 *
 * 1 — original, unversioned: question ids invented by the model on every run.
 * 2 — question and checklist ids derived from their own text (TLY-40).
 * 3 — aiUsePolicy: what the pack says about producing the response with AI
 *     (TLY-74). Absent on older analyses, which is why it reads as not-stated
 *     rather than unrestricted until the tender is analysed again.
 * 4 — lots become structured records rather than bare strings, and gates and
 *     questions carry the lot they belong to (TLY-41).
 */
export const ANALYSIS_SCHEMA_VERSION = "4";

/**
 * Identifiers must be a function of the question itself, not of when it was
 * generated. The model invents a fresh id on every analysis, so answers keyed on
 * those ids were orphaned by any re-run — silent data loss for work a human had
 * already reviewed and marked ready.
 */
function fingerprint(prefix: string, ...parts: string[]) {
  const normalised = parts
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${prefix}-${createHash("sha256").update(normalised).digest("hex").slice(0, 12)}`;
}

export const questionId = (title: string, prompt: string) => fingerprint("q", title, prompt);
export const checklistItemId = (label: string, kind: string) => fingerprint("c", label, kind);

/**
 * Rewrites the model's identifiers to stable ones and stamps the schema version.
 * Run on every analysis, including the deterministic no-key fallback.
 */
/**
 * Before TLY-41 a lot was a bare string. Those are kept as a titled lot with no
 * scope and an explicit marker for the value, rather than dropped: the pack did
 * say the tender was divided, and losing that is worse than an incomplete row.
 */
function migrateLots(lots: TenderAnalysis["lots"] | string[] | undefined): TenderAnalysis["lots"] {
  return (lots ?? []).map((lot, index) => {
    if (typeof lot !== "string") return lot;
    return {
      id: lot.trim() || `Lot ${index + 1}`,
      title: lot.trim(),
      scope: "",
      estimatedValue: "[INPUT NEEDED: lot value]",
      evidence: { sourceDocument: "", quote: "", confidence: "LOW" as const },
    };
  });
}

export function withStableIds(analysis: TenderAnalysis): TenderAnalysis {
  return {
    ...analysis,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    lots: migrateLots(analysis.lots as TenderAnalysis["lots"] | string[] | undefined),
    questions: (analysis.questions ?? []).map((question) => ({
      ...question,
      id: questionId(question.title, question.prompt),
    })),
    submissionChecklist: (analysis.submissionChecklist ?? []).map((item) => ({
      ...item,
      id: checklistItemId(item.label, item.kind),
    })),
  };
}

export type OrphanedAnswer = {
  questionId: string;
  response: string;
  status: string;
};

/**
 * Answers whose question is no longer in the analysis. They are never deleted:
 * a human may have written them, so they surface for a person to decide about.
 */
export function orphanedAnswers(analysis: TenderAnalysis | null, answers: BidAnswer[]): OrphanedAnswer[] {
  const live = new Set((analysis?.questions ?? []).map((question) => question.id));
  return answers
    .filter((answer) => !live.has(answer.questionId) && answer.response.trim().length > 0)
    .map((answer) => ({ questionId: answer.questionId, response: answer.response, status: answer.status }));
}

/**
 * Maps a pre-version-2 analysis onto stable ids, returning the id remapping so
 * saved answers and checklist overrides can be re-keyed with it.
 */
export function remapLegacyAnalysis(analysis: TenderAnalysis): {
  analysis: TenderAnalysis;
  questionIdMap: Map<string, string>;
  checklistIdMap: Map<string, string>;
} {
  const questionIdMap = new Map<string, string>();
  const checklistIdMap = new Map<string, string>();
  for (const question of analysis.questions ?? []) {
    questionIdMap.set(question.id, questionId(question.title, question.prompt));
  }
  for (const item of analysis.submissionChecklist ?? []) {
    checklistIdMap.set(item.id, checklistItemId(item.label, item.kind));
  }
  return { analysis: withStableIds(analysis), questionIdMap, checklistIdMap };
}

export const needsMigration = (analysis: TenderAnalysis | null | undefined) =>
  Boolean(analysis) && analysis?.schemaVersion !== ANALYSIS_SCHEMA_VERSION;

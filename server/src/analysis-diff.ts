import type { TenderAnalysis } from "./types.js";

/**
 * What changed between two analyses of the same tender.
 *
 * Buyers amend packs and publish clarifications mid-competition, often moving
 * the deadline or rewriting a requirement. Overwriting the previous analysis
 * meant nobody saw it, and answers already marked ready went stale silently.
 *
 * The diff is structural rather than textual: a question is identified by its
 * stable id, so a reworded question is a change to that question rather than a
 * removal and an unrelated addition.
 */

export type AnalysisChange =
  | { kind: "deadline"; before: string; after: string }
  | { kind: "question-added"; questionId: string; title: string }
  | { kind: "question-removed"; questionId: string; title: string }
  | { kind: "question-changed"; questionId: string; title: string; before: string; after: string }
  | { kind: "gate-added"; requirement: string }
  | { kind: "gate-removed"; requirement: string }
  | { kind: "gate-status"; requirement: string; before: string; after: string }
  | { kind: "criterion-reweighted"; name: string; before: number; after: number }
  | { kind: "criterion-added"; name: string; weight: number }
  | { kind: "criterion-removed"; name: string };

export const NO_CHANGES = "No changes since the previous analysis";

/** Normalised for comparison: whitespace and case are not a material change. */
const flat = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Compares two analyses.
 *
 * Only differences a bidder would act on are reported. A reworded prompt that
 * means the same thing is noise, and a panel full of noise is one nobody reads.
 */
export function diffAnalyses(before: TenderAnalysis | null, after: TenderAnalysis): AnalysisChange[] {
  if (!before) return [];
  const changes: AnalysisChange[] = [];

  if (flat(before.deadline) !== flat(after.deadline)) {
    changes.push({ kind: "deadline", before: before.deadline, after: after.deadline });
  }

  // Identifiers are derived from the question's own text (TLY-40), so rewording
  // a prompt changes the id. Matching on the title as well is what lets a
  // reworded question read as a change rather than as a removal and an
  // unrelated addition — which is the whole point of an amendment panel.
  const byTitle = (questions: TenderAnalysis["questions"]) =>
    new Map(questions.map((question) => [flat(question.title), question]));
  const beforeById = new Map(before.questions.map((question) => [question.id, question]));
  const afterById = new Map(after.questions.map((question) => [question.id, question]));
  const beforeByTitle = byTitle(before.questions);
  const afterByTitle = byTitle(after.questions);

  const matchFor = (question: TenderAnalysis["questions"][number], byId: typeof beforeById, byTitleMap: typeof beforeByTitle) =>
    byId.get(question.id) ?? byTitleMap.get(flat(question.title));

  for (const question of after.questions) {
    if (!matchFor(question, beforeById, beforeByTitle)) {
      changes.push({ kind: "question-added", questionId: question.id, title: question.title });
    }
  }
  for (const question of before.questions) {
    const current = matchFor(question, afterById, afterByTitle);
    if (!current) {
      changes.push({ kind: "question-removed", questionId: question.id, title: question.title });
      continue;
    }
    if (flat(question.prompt) !== flat(current.prompt) || question.weight !== current.weight || question.maxWords !== current.maxWords) {
      // The id reported is the one the answer is keyed on today, so the caller
      // can flag the right answer.
      changes.push({ kind: "question-changed", questionId: question.id, title: current.title, before: question.prompt, after: current.prompt });
    }
  }

  const beforeGates = new Map(before.fatalGates.map((gate) => [flat(gate.requirement), gate]));
  const afterGates = new Map(after.fatalGates.map((gate) => [flat(gate.requirement), gate]));
  for (const [key, gate] of afterGates) {
    if (!beforeGates.has(key)) { changes.push({ kind: "gate-added", requirement: gate.requirement }); continue; }
    const previous = beforeGates.get(key)!;
    if (previous.status !== gate.status) {
      changes.push({ kind: "gate-status", requirement: gate.requirement, before: previous.status, after: gate.status });
    }
  }
  for (const [key, gate] of beforeGates) {
    if (!afterGates.has(key)) changes.push({ kind: "gate-removed", requirement: gate.requirement });
  }

  const beforeCriteria = new Map(before.evaluationCriteria.map((criterion) => [flat(criterion.name), criterion]));
  const afterCriteria = new Map(after.evaluationCriteria.map((criterion) => [flat(criterion.name), criterion]));
  for (const [key, criterion] of afterCriteria) {
    if (!beforeCriteria.has(key)) { changes.push({ kind: "criterion-added", name: criterion.name, weight: criterion.weight }); continue; }
    const previous = beforeCriteria.get(key)!;
    if (previous.weight !== criterion.weight) {
      changes.push({ kind: "criterion-reweighted", name: criterion.name, before: previous.weight, after: criterion.weight });
    }
  }
  for (const [key, criterion] of beforeCriteria) {
    if (!afterCriteria.has(key)) changes.push({ kind: "criterion-removed", name: criterion.name });
  }

  return changes;
}

/**
 * Questions whose answers should be looked at again.
 *
 * Flagged, never invalidated: a person wrote that answer, and deciding on their
 * behalf that it is now worthless would throw away real work over a change they
 * might judge immaterial.
 */
export function questionsNeedingReview(changes: AnalysisChange[]) {
  return changes
    .filter((change): change is Extract<AnalysisChange, { kind: "question-changed" }> => change.kind === "question-changed")
    .map((change) => change.questionId);
}

/** One line per change, for the panel and for an audit entry. */
export function describeChange(change: AnalysisChange) {
  switch (change.kind) {
    case "deadline": return `Deadline moved from ${change.before || "not stated"} to ${change.after || "not stated"}`;
    case "question-added": return `Question added: ${change.title}`;
    case "question-removed": return `Question removed: ${change.title}`;
    case "question-changed": return `Question changed: ${change.title}`;
    case "gate-added": return `Requirement added: ${change.requirement}`;
    case "gate-removed": return `Requirement removed: ${change.requirement}`;
    case "gate-status": return `${change.requirement}: ${change.before} → ${change.after}`;
    case "criterion-reweighted": return `${change.name} reweighted from ${change.before}% to ${change.after}%`;
    case "criterion-added": return `Award criterion added: ${change.name} (${change.weight}%)`;
    case "criterion-removed": return `Award criterion removed: ${change.name}`;
  }
}

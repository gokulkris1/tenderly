import type { EvaluationCriterion } from "./types.js";

/**
 * A mock evaluation of the drafted response against the published criteria.
 *
 * The red-team endpoint returned free-text critique. With weightings extracted,
 * the same effort can produce a prioritised work list instead: which criterion
 * is losing marks, and which answer is losing them.
 *
 * The number is an estimate, never a prediction. We do not know the buyer's
 * panel, the competing bids or the moderation, and presenting it as a forecast
 * would be a confident claim about something unknowable.
 */

export const ESTIMATE_NOTICE =
  "An internal estimate against the published criteria — not a prediction of the buyer's award.";

export type CriterionScore = {
  name: string;
  mark: number;
  maximum: number;
  reasoning: string;
  gap: string;
  /** The scored question whose answer caused the gap; empty when none. */
  questionId: string;
  /** The mark's contribution to the weighted total. */
  weightedContribution: number;
  /** True when the criterion scored below half marks. */
  belowHalf: boolean;
};

export type MockEvaluation = {
  id: string;
  tenderId: string;
  criteria: CriterionScore[];
  /** Percentage of the total award this draft would earn on these marks. */
  total: number;
  notice: string;
  actor: string;
  createdAt: string;
};

/**
 * Turns raw per-criterion marks into weighted contributions and a total.
 *
 * The weight comes from the extracted criteria, not from the model: the model
 * scores, the arithmetic is ours. A criterion the model returns that the pack
 * never stated is dropped rather than given a weight we invented.
 */
export function scoreEvaluation(
  raw: { name: string; mark: number; maximum: number; reasoning: string; gap: string; questionId: string }[],
  criteria: EvaluationCriterion[],
): { criteria: CriterionScore[]; total: number } {
  const weights = new Map(criteria.map((criterion) => [criterion.name.toLowerCase().trim(), criterion.weight]));

  const scored: CriterionScore[] = [];
  for (const entry of raw) {
    const weight = weights.get(entry.name.toLowerCase().trim());
    if (weight === undefined) continue;  // Not a criterion the pack stated.
    const maximum = entry.maximum > 0 ? entry.maximum : 100;
    const mark = Math.max(0, Math.min(entry.mark, maximum));
    scored.push({
      name: entry.name,
      mark,
      maximum,
      reasoning: entry.reasoning,
      gap: entry.gap,
      questionId: entry.questionId,
      weightedContribution: Math.round((mark / maximum) * weight * 10) / 10,
      belowHalf: mark < maximum / 2,
    });
  }

  const total = Math.round(scored.reduce((sum, entry) => sum + entry.weightedContribution, 0) * 10) / 10;
  return { criteria: scored, total };
}

/**
 * Criteria losing the most weighted marks, worst first: the work list.
 *
 * Marks lost is the weighted contribution forgone — the full weight minus what
 * was earned. A criterion worth 60% scoring half its marks has lost 30 points
 * of the total, which is what makes it the thing to fix first.
 */
export function prioritisedGaps(scored: CriterionScore[], criteria: EvaluationCriterion[]) {
  const weights = new Map(criteria.map((criterion) => [criterion.name.toLowerCase().trim(), criterion.weight]));
  return scored
    .filter((entry) => entry.gap.trim().length > 0 && entry.mark < entry.maximum)
    .map((entry) => ({
      criterion: entry.name,
      gap: entry.gap,
      questionId: entry.questionId,
      marksLost: Math.round(((weights.get(entry.name.toLowerCase().trim()) ?? 0) - entry.weightedContribution) * 10) / 10,
    }))
    .sort((a, b) => b.marksLost - a.marksLost);
}

import type { BidDecision, EligibilityGate } from "./types.js";
import type { DeadlinePressure } from "./pressure.js";

/**
 * What to do about this tender, decided in code.
 *
 * The badge used to come from a single model call with no visible reasoning: a
 * user could not tell why a tender was a No-Go, so they could not argue with
 * it. The band is now decided by rules over facts already on the screen, and
 * the model's only remaining job is to write the rationale prose from those
 * same facts.
 *
 * The rules are deliberately conservative in the same direction as everything
 * else in the product: an unresolved gate is a Review, never a Go.
 */

export type DecisionInputs = {
  /** Gates already scoped to the lots the user is bidding. */
  gates: EligibilityGate[];
  fitScore: number;
  pressure?: DeadlinePressure;
  /** True when the failing gaps are the kind a partner could close. */
  partnerCloseable: boolean;
  /** Awards this buyer has made under this CPV, when known. */
  awardCount?: number;
};

export type DecisionResult = {
  decision: BidDecision;
  /** The facts the rationale may cite, and nothing else. */
  facts: string[];
  /** Why the band came out as it did, in one line. */
  reason: string;
};

/**
 * Decides the band from the inputs.
 *
 * Any hard FAIL forces Partner or No-Go — never a Go, whatever the fit score
 * says. Any REVIEW forces Review: missing evidence is the product's central
 * rule and it does not bend for a high score.
 */
export function decide(inputs: DecisionInputs): DecisionResult {
  const relevant = inputs.gates.filter((gate) => gate.status !== "NOT_APPLICABLE");
  const failing = relevant.filter((gate) => gate.status === "FAIL");
  const reviewing = relevant.filter((gate) => gate.status === "REVIEW");

  const facts: string[] = [`Fit score ${inputs.fitScore}`];
  facts.push(relevant.length === 0
    ? "No eligibility gates were extracted"
    : `${relevant.filter((gate) => gate.status === "PASS").length} of ${relevant.length} gates pass`);
  if (failing.length) facts.push(`Failing gates: ${failing.map((gate) => gate.requirement).join("; ")}`);
  if (reviewing.length) facts.push(`Unresolved gates: ${reviewing.map((gate) => gate.requirement).join("; ")}`);
  if (inputs.pressure?.band) {
    facts.push(`Deadline pressure ${inputs.pressure.band}, ${inputs.pressure.workingDaysRemaining} working days remaining`);
    if (inputs.pressure.competingBids.length) {
      facts.push(`${inputs.pressure.competingBids.length} other bid${inputs.pressure.competingBids.length > 1 ? "s" : ""} close in the same week`);
    }
  } else if (inputs.pressure?.note) {
    facts.push("The submission deadline could not be read from the pack");
  }
  if (typeof inputs.awardCount === "number" && inputs.awardCount > 0) {
    facts.push(`This buyer has made ${inputs.awardCount} award${inputs.awardCount > 1 ? "s" : ""} under this CPV`);
  }

  if (failing.length > 0) {
    return inputs.partnerCloseable
      ? { decision: "PARTNER", facts, reason: `${failing.length} hard gate${failing.length > 1 ? "s" : ""} fail, and the gap could be closed with a partner`, }
      : { decision: "NO_GO", facts, reason: `${failing.length} hard gate${failing.length > 1 ? "s" : ""} fail and cannot be closed` };
  }
  if (reviewing.length > 0) {
    return { decision: "REVIEW", facts, reason: `${reviewing.length} gate${reviewing.length > 1 ? "s" : ""} cannot be decided without more evidence` };
  }
  if (relevant.length === 0) {
    return { decision: "REVIEW", facts, reason: "No eligibility gates were extracted, so nothing has been checked" };
  }
  if (inputs.pressure?.band === "High") {
    return { decision: "REVIEW", facts, reason: "Every gate passes, but there is very little time left to bid" };
  }
  if (inputs.fitScore < 40) {
    return { decision: "REVIEW", facts, reason: "Every gate passes, but the fit score is low" };
  }
  return { decision: "GO", facts, reason: "Every gate passes and there is time to bid" };
}

/**
 * Checks a rationale against the facts it was given.
 *
 * The model may only restate what it was handed. Any number in the prose that
 * is not in the facts is a fabrication, and a fabricated figure on a bid
 * recommendation is exactly the failure this product exists to avoid.
 */
export function unsupportedFigures(rationale: string, facts: string[]): string[] {
  const numbersIn = (text: string) => [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0].replace(/,/g, ""));
  const allowed = new Set(facts.flatMap(numbersIn));
  return [...new Set(numbersIn(rationale))].filter((figure) => !allowed.has(figure));
}

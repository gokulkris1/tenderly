import type { TenderAnalysis } from "./types.js";

/**
 * What the pack's AI-use policy obliges the bidder to do, in one sentence.
 *
 * This mapping is deliberately deterministic: the model may or may not mention
 * the declaration duty, so the product derives it from the analysed policy and
 * attaches it wherever claims-to-verify are delivered — drafting, refinement,
 * batch runs and the serialized tender a user sees on reload. A silent pack
 * earns no reminder: not-stated is not a rule.
 */

export const AI_DISCLOSURE_REMINDER =
  "This tender requires tenderers to declare AI assistance: complete the pack's AI-use declaration before submission.";

export const AI_PROHIBITION_REMINDER =
  "This tender prohibits AI-generated content: a human must decide whether AI-drafted text is rewritten by hand or removed before submission.";

export function aiPolicyReminder(policy: TenderAnalysis["aiUsePolicy"] | undefined): string | null {
  if (policy?.state === "disclosure-required") return AI_DISCLOSURE_REMINDER;
  if (policy?.state === "prohibited") return AI_PROHIBITION_REMINDER;
  return null;
}

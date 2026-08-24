import { createHash } from "node:crypto";
import { badgeFor, summarise } from "./provenance.js";
import type { BidAnswer, ProvenanceEntry, TenderAnalysis } from "./types.js";

/**
 * The moat rule is that a human reviews before anything leaves the system.
 *
 * The final pack used to download the moment the automated blockers cleared,
 * with no moment where a named person states they have reviewed the content and
 * understand how it was produced. The attestation is that moment, and it is
 * bound to the exact content it was made against: change an answer and it no
 * longer applies.
 */

export type Attestation = {
  actor: string;
  at: string;
  /** The content this attestation was made against. */
  contentVersion: string;
};

/**
 * A fingerprint of everything the attester would have read. Any edit to any
 * answer's text or status produces a different version, which is what makes an
 * attestation invalidate rather than silently carry over.
 */
export function contentVersion(answers: BidAnswer[]) {
  const canonical = [...answers]
    .sort((a, b) => a.questionId.localeCompare(b.questionId))
    .map((answer) => `${answer.questionId} ${answer.status} ${answer.response}`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** True when the attestation was made against exactly this content. */
export function attestationValid(attestation: Attestation | undefined, answers: BidAnswer[]) {
  return Boolean(attestation) && attestation!.contentVersion === contentVersion(answers);
}

export type ProvenanceSummary = {
  counts: { "ai-generated": number; "ai-assisted": number; human: number };
  /** Section titles a model wrote, named so the attester knows what they cover. */
  aiGeneratedSections: string[];
  /** Set when the pack prohibits AI content and a section was written by one. */
  conflict?: string;
};

/**
 * What the attester is being asked to stand behind: how many sections exist by
 * class, which of them a model wrote, and whether that contradicts the pack.
 */
export function provenanceSummary(
  analysis: TenderAnalysis | null,
  answers: BidAnswer[],
  provenance: ProvenanceEntry[],
): ProvenanceSummary {
  const { counts, aiGenerated } = summarise(provenance);
  const titleFor = (answerId: string) => {
    const answer = answers.find((item) => item.id === answerId);
    if (!answer) return answerId;
    return analysis?.questions.find((question) => question.id === answer.questionId)?.title ?? answer.questionId;
  };
  const aiGeneratedSections = aiGenerated.map(titleFor).sort();
  const summary: ProvenanceSummary = { counts, aiGeneratedSections };
  if (analysis?.aiUsePolicy?.state === "prohibited" && aiGeneratedSections.length > 0) {
    const plural = aiGeneratedSections.length > 1 ? "s were" : " was";
    summary.conflict = `This tender prohibits AI-generated content, and ${aiGeneratedSections.length} section${plural} written by a model: ${aiGeneratedSections.join(", ")}`;
  }
  return summary;
}

/**
 * The provenance file that travels inside the final pack, so the record of how
 * the response was produced leaves the system with the response itself.
 */
export function provenanceSummaryFile(args: {
  analysis: TenderAnalysis | null;
  answers: BidAnswer[];
  provenance: ProvenanceEntry[];
  attestation?: Attestation;
}) {
  const byAnswer = new Map<string, ProvenanceEntry[]>();
  for (const entry of args.provenance) byAnswer.set(entry.answerId, [...(byAnswer.get(entry.answerId) ?? []), entry]);
  const lines = ["TENDERLY PROVENANCE SUMMARY", "", "How each section of this response was produced.", ""];
  for (const answer of args.answers) {
    const title = args.analysis?.questions.find((question) => question.id === answer.questionId)?.title ?? answer.questionId;
    const badge = badgeFor(byAnswer.get(answer.id) ?? []);
    if (!badge) {
      lines.push(`- ${title}: no provenance recorded`);
      continue;
    }
    const detail = badge.model ? `model ${badge.model}, prompt ${badge.promptVersion ?? "not recorded"}` : "written by a person";
    lines.push(`- ${title}: ${badge.class} (${detail}; last change by ${badge.actor} at ${badge.createdAt})`);
  }
  lines.push("");
  lines.push(args.attestation
    ? `Attested by ${args.attestation.actor} at ${args.attestation.at} against content version ${args.attestation.contentVersion}.`
    : "No attestation recorded.");
  return `${lines.join("\n")}\n`;
}

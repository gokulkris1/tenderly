import { createHash } from "node:crypto";
import { badgeFor, summarise } from "./provenance.js";
import type { BidAnswer, ProvenanceEntry, StoredDocument, TenderAnalysis, TenderRecord } from "./types.js";

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
  /**
   * Per-part fingerprints, so an invalidated attestation can say what moved.
   *
   * Absent on attestations recorded before TLY-242. Those are treated as
   * invalid, which is the safe direction: they were made against a definition
   * of "this content" that did not include the documents, the lots, the
   * checklist or the people, so the statement they carry is weaker than the one
   * the product now claims to hold.
   */
  parts?: ContentParts;
};

/** What the attester stood behind, one fingerprint per part. */
export type ContentParts = {
  answers: string;
  documents: string;
  lots: string;
  checklist: string;
  roles: string;
  analysis: string;
};

/**
 * Everything an attestation is made against.
 *
 * Deliberately the same inputs `submissionBlockers` already receives, so every
 * route computes the same verdict. A fingerprint that needed an extra lookup
 * would be computed one way on one path and another way on another, which is
 * the divergence TLY-236 was.
 */
export type AttestableContent = {
  tender: TenderRecord;
  analysis: TenderAnalysis | null;
  answers: BidAnswer[];
  documents: StoredDocument[];
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Readable names for each part, used when reporting what changed. */
const PART_LABELS: Record<keyof ContentParts, string> = {
  answers: "the answers",
  documents: "the submission documents",
  lots: "the lot selection",
  checklist: "the checklist",
  roles: "the people assigned to roles",
  analysis: "the tender analysis",
};

/**
 * Fingerprints each part of what the attester would have read.
 *
 * `contentVersion` used to hash answer text and status and nothing else, so a
 * named person's "I have reviewed this" survived swapping a submission
 * document, changing which lots were being bid, ticking a checklist item,
 * re-analysing the pack and archiving a cited person (TLY-242). Every one of
 * those changes what the buyer receives.
 *
 * Orphaned answers are excluded. When re-analysis drops a question its
 * bid_answers row stays, invisible to every screen because they iterate
 * analysis.questions — but the old hash sorted over all answers, so the
 * fingerprint moved for a reason nobody could see or fix, and the only remedy
 * offered was to attest again.
 */
export function contentParts(content: AttestableContent): ContentParts {
  const live = content.analysis
    ? new Set(content.analysis.questions.map((question) => question.id))
    : null;
  const answers = [...content.answers]
    .filter((answer) => !live || live.has(answer.questionId))
    .sort((a, b) => a.questionId.localeCompare(b.questionId))
    .map((answer) => `${answer.questionId} ${answer.status} ${answer.response}`)
    .join("");

  // Only submission documents: the files that actually go to the buyer. A new
  // source document changes the analysis, which this covers separately.
  const documents = content.documents
    .filter((document) => document.role === "submission")
    // Identity and content: a replaced file keeping its name must still count
    // as a change, so the stored bytes are fingerprinted rather than trusted
    // to differ by name.
    .map((document) => `${document.filename} ${document.mimeType} ${document.bytes ? digest(document.bytes.toString("base64")) : document.extractionStatus}`)
    .sort()
    .join("|");

  const metadata = content.tender.metadata ?? {};
  const lots = [...((metadata.selectedLots ?? []) as string[])].sort().join("|");
  const overrides = (metadata.checklistOverrides ?? {}) as Record<string, string>;
  const checklist = Object.keys(overrides).sort().map((key) => `${key}=${overrides[key]}`).join("|");

  // Who is named for which role. Whether that person is still active staff is
  // deliberately not fingerprinted here: matchRoles already builds candidates
  // from active people only, so a mandatory role whose assignee has been
  // archived produces a pack blocker through roleBlockers. Reading the people
  // table here would make this fingerprint depend on a lookup that most
  // submissionBlockers call sites do not perform, and an attestation that is
  // valid on one route and invalid on another is worse than one that misses a
  // case another check already holds.
  const assignments = (metadata.roleAssignments ?? {}) as Record<string, string>;
  const roles = Object.keys(assignments).sort().map((role) => `${role}=${assignments[role]}`).join("|");

  // The analysis as a whole: a re-analysis rewrites the questions, the gates and
  // the weightings the attester read.
  const analysis = content.analysis ? digest(JSON.stringify(content.analysis)) : "none";

  return {
    answers: digest(answers),
    documents: digest(documents),
    lots: digest(lots),
    checklist: digest(checklist),
    roles: digest(roles),
    analysis,
  };
}

/** One fingerprint over every part, for display and for the pack summary. */
export function contentVersion(content: AttestableContent) {
  const parts = contentParts(content);
  return digest(Object.keys(parts).sort().map((key) => `${key}:${parts[key as keyof ContentParts]}`).join("|"));
}

/**
 * Whether the attestation still holds, and if not, what moved.
 *
 * Naming the change matters: "the attestation is no longer valid" tells the
 * attester to repeat themselves, where "the submission documents changed" tells
 * them what to look at before they do.
 */
export function attestationStatus(attestation: Attestation | undefined, content: AttestableContent) {
  if (!attestation) return { valid: false, recorded: false, changed: [] as string[] };
  const now = contentParts(content);
  if (!attestation.parts) {
    // Recorded before the fingerprint covered more than the answers. Not
    // trusted, and said plainly rather than reported as an unexplained mismatch.
    return {
      valid: false, recorded: true,
      changed: ["this attestation was recorded before documents, lots, the checklist and people were covered"],
    };
  }
  const changed = (Object.keys(now) as (keyof ContentParts)[])
    .filter((key) => now[key] !== attestation.parts![key])
    .map((key) => PART_LABELS[key]);
  return { valid: changed.length === 0, recorded: true, changed };
}

/** True when the attestation was made against exactly this content. */
export function attestationValid(attestation: Attestation | undefined, content: AttestableContent) {
  return attestationStatus(attestation, content).valid;
}

/** Answers whose question the analysis no longer has, reported rather than hashed. */
export function orphanedAttestableAnswers(content: AttestableContent) {
  if (!content.analysis) return [];
  const live = new Set(content.analysis.questions.map((question) => question.id));
  return content.answers.filter((answer) => !live.has(answer.questionId));
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

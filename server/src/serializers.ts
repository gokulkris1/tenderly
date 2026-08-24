import type { AiUsePolicy as AiUsePolicyWire, ScoreBreakdown, TenderCpv as TenderCpvWire, Tender } from "@tenderly/shared";
import { ANALYSIS_SCHEMA_VERSION, orphanedAnswers } from "./analysis-schema.js";
import { normaliseCpv } from "./cpv.js";
import { badgeFor } from "./provenance.js";
import type { BidAnswer, EvidenceRecord, ProvenanceEntry, PublicTender, RequiredCertificate, TenderAnalysis, TenderRecord } from "./types.js";

function accessLabel(access: TenderRecord["analysis"] extends infer _T ? string : never) {
  return access === "OPEN_TO_QUALIFIED_BIDDERS" ? "Open to qualified bidders" : access === "FRAMEWORK_MEMBERS_ONLY" ? "Framework members only" : access === "INVITED_ONLY" ? "Invited bidders only" : "Needs source review";
}

function bidTypeLabel(type: string) {
  const labels: Record<string, string> = {
    OPEN_CONTRACT: "Direct contract",
    FRAMEWORK_ESTABLISHMENT: "Framework establishment",
    FRAMEWORK_MINI_COMPETITION: "Existing framework mini-competition",
    DPS: "Dynamic purchasing system",
    RESTRICTED: "Restricted procedure",
    NEGOTIATED: "Negotiated procedure",
    UNKNOWN: "Needs source review",
  };
  return labels[type] ?? "Needs source review";
}

/**
 * Stated weightings that do not add up are reported as stated, never rescaled:
 * silently normalising them would hide a defect in the buyer's own pack.
 */
export function awardCriteriaWarning(criteria: { weight: number }[]): string | undefined {
  if (criteria.length === 0) return undefined;
  const total = Math.round(criteria.reduce((sum, c) => sum + (c.weight || 0), 0));
  if (total === 100) return undefined;
  return `Stated weightings sum to ${total}%`;
}

/**
 * A required certificate counts as satisfied only when a VERIFIED evidence item
 * plausibly covers it. Unverified evidence never satisfies a requirement — that
 * is the same rule the drafting path follows.
 */
export function certificateStatus(certificates: RequiredCertificate[], evidence: EvidenceRecord[] = []) {
  const verified = evidence.filter((item) => item.verified);
  const words = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  return certificates.map((certificate) => {
    const needle = words(certificate.name);
    const match = verified.find((item) => {
      const haystack = words(`${item.name} ${item.kind}`);
      const overlap = [...needle].filter((w) => haystack.has(w)).length;
      return needle.size > 0 && overlap >= Math.min(2, needle.size);
    });
    return {
      name: certificate.name,
      issuingBody: certificate.issuingBody,
      mandatory: certificate.mandatory,
      satisfied: Boolean(match),
      satisfiedBy: match?.name,
      source: certificate.evidence.sourceDocument,
      quote: certificate.evidence.quote,
    };
  });
}

/**
 * An analysis that predates TLY-74 has no policy at all. It reads as not-stated
 * rather than unrestricted: we have not looked, so we cannot say we were allowed.
 */
export function aiUsePolicy(
  policy: TenderAnalysis["aiUsePolicy"],
  acknowledgement: unknown,
): AiUsePolicyWire {
  const ack = acknowledgement as AiUsePolicyWire["acknowledgement"] | undefined;
  if (!policy) {
    return { state: "not-stated", source: "", quote: "", confidence: "LOW", acknowledgement: ack };
  }
  return {
    state: policy.state,
    source: policy.evidence.sourceDocument,
    quote: policy.evidence.quote,
    confidence: policy.evidence.confidence,
    acknowledgement: ack,
  };
}

/**
 * How a tender's CPV is presented.
 *
 * A code we hold is shown canonically with its description. Anything else is
 * shown exactly as the source wrote it, marked unrecognised — inventing a
 * description for a code we do not have would be a guess presented as a fact.
 */
export function tenderCpv(tender: TenderRecord): TenderCpvWire | undefined {
  const raw = ["CPV Codes", "cpv", "CPV", "classification-cpv"]
    .map((key) => tender.metadata[key])
    .find((value) => typeof value === "string" && value.trim().length > 0) as string | undefined;
  if (!raw) return undefined;
  const normalised = normaliseCpv(raw);
  if (!normalised) return { raw, recognised: false };
  return {
    raw,
    code: normalised.code,
    description: normalised.description,
    ancestors: normalised.ancestors.map((entry) => ({ code: entry.code, description: entry.description })),
    recognised: true,
  };
}

export function serializeTender(tender: TenderRecord, answers: BidAnswer[] = [], evidence: EvidenceRecord[] = [], provenance: ProvenanceEntry[] = []): Tender {
  const analysis = tender.analysis;
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer]));
  const ledger = new Map<string, ProvenanceEntry[]>();
  for (const entry of provenance) {
    ledger.set(entry.answerId, [...(ledger.get(entry.answerId) ?? []), entry]);
  }
  const checklistOverrides = (tender.metadata.checklistOverrides ?? {}) as Record<string, "READY" | "ACTION" | "VERIFY">;
  return {
    id: tender.id,
    resourceId: tender.externalId || "Imported",
    title: tender.title,
    authority: tender.authority || "Contracting authority",
    category: String(tender.metadata["Procurement Type"] ?? "Public procurement"),
    procedure: tender.procedure || "Review",
    deadline: analysis?.deadline || tender.deadline || "Verify deadline",
    value: analysis?.contractValue || tender.estimatedValue || "Not stated",
    match: analysis?.fitScore ?? 0,
    decision: analysis?.decision ?? "REVIEW",
    access: accessLabel(analysis?.access ?? "UNKNOWN"),
    summary: analysis?.executiveSummary || tender.description || "Imported opportunity — run qualification after the full tender pack is available.",
    sourceUrl: tender.sourceUrl,
    published: tender.published || "",
    framework: bidTypeLabel(analysis?.bidType ?? "UNKNOWN"),
    partnerNote: analysis?.partnerNeeded ? analysis.partnerGaps.join(" · ") : undefined,
    eligibility: analysis?.eligibility ?? "REVIEW",
    gates: analysis?.fatalGates.map((gate) => ({
      label: gate.requirement,
      state: gate.status === "FAIL" ? "fail" : gate.status === "REVIEW" ? "review" : "pass",
      bidder: gate.bidderEvidence,
      requirement: gate.action || gate.requirement,
      source: `${gate.evidence.sourceDocument}${gate.evidence.quote ? ` · “${gate.evidence.quote}”` : ""}`,
    })) ?? [{ label: "Tender pack review", state: "review", bidder: "Not analysed", requirement: "Import documents and run qualification", source: "eTenders notice" }],
    questions: analysis?.questions.map((question) => {
      const saved = answerMap.get(question.id);
      return {
        id: question.id,
        title: question.title,
        weight: question.weight,
        maxWords: question.maxWords,
        required: question.required,
        status: saved?.status === "ready" ? "ready" : saved?.status === "needs-input" ? "needs-input" : "draft",
        prompt: question.prompt,
        answer: saved?.response ?? "",
        evidence: question.evidenceNeeded,
        provenance: saved ? badgeFor(ledger.get(saved.id) ?? []) : undefined,
      };
    }) ?? [],
    roles: analysis?.roles.map((role) => ({
      role: role.role,
      quantity: role.quantity,
      experience: role.minimumExperience,
      qualifications: role.qualifications,
      cvRequired: role.cvRequired,
      bidderMatch: role.bidderMatch,
      status: role.status,
      action: role.action,
      source: `${role.evidence.sourceDocument}${role.evidence.quote ? ` · “${role.evidence.quote}”` : ""}`,
    })) ?? [],
    submissionChecklist: analysis?.submissionChecklist.map((item) => ({
      id: item.id,
      label: item.label,
      required: item.required,
      kind: item.kind,
      status: checklistOverrides[item.id] ?? item.status,
      source: `${item.source.sourceDocument}${item.source.quote ? ` · “${item.source.quote}”` : ""}`,
    })) ?? [],
    risks: analysis?.risks ?? [],
    synopsisSlides: analysis?.synopsisSlides ?? [],
    schemaVersion: analysis?.schemaVersion,
    promptVersion: analysis?.promptVersion,
    analysisOutdated: Boolean(analysis) && analysis?.schemaVersion !== ANALYSIS_SCHEMA_VERSION,
    orphanedAnswers: orphanedAnswers(analysis ?? null, answers),
    awardCriteria: (analysis?.evaluationCriteria ?? []).map((criterion) => ({
      name: criterion.name,
      weight: criterion.weight,
      rawWeight: criterion.rawWeight,
      confidence: criterion.confidence,
      source: criterion.evidence.sourceDocument,
      quote: criterion.evidence.quote,
    })),
    awardCriteriaWarning: awardCriteriaWarning(analysis?.evaluationCriteria ?? []),
    formalities: (analysis?.formalities ?? []).map((formality) => ({
      rule: formality.rule,
      appliesTo: formality.appliesTo,
      source: formality.evidence.sourceDocument,
      quote: formality.evidence.quote,
    })),
    requiredCertificates: certificateStatus(analysis?.requiredCertificates ?? [], evidence),
    aiUsePolicy: aiUsePolicy(analysis?.aiUsePolicy, tender.metadata.aiPolicyAcknowledgement),
    cpv: tenderCpv(tender),
    noAiMode: tender.metadata.noAiMode === true,
  };
}

export function serializePublicTender(tender: PublicTender, score: number | ScoreBreakdown): Tender {
  const breakdown = typeof score === "number" ? undefined : score;
  const matchScore = typeof score === "number" ? score : score.total;
  return {
    id: `public-${tender.externalId}`,
    resourceId: tender.externalId,
    title: tender.title,
    authority: tender.authority,
    category: "Public opportunity",
    procedure: tender.procedure || "Review",
    deadline: tender.deadline || "Verify deadline",
    value: tender.estimatedValue || "Not stated",
    match: matchScore,
    decision: "REVIEW",
    access: "Import pack to verify",
    summary: tender.description,
    sourceUrl: tender.sourceUrl,
    published: tender.published,
    framework: /framework/i.test(tender.title) ? "Framework mentioned — import to classify" : "Import to classify",
    gates: [{ label: "Full eligibility", state: "review", bidder: "Not checked", requirement: "Import tender pack", source: "eTenders public listing" }],
    questions: [],
    scoreBreakdown: breakdown,
  };
}

import type { BidAnswer, PublicTender, TenderRecord } from "./types.js";

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

export function serializeTender(tender: TenderRecord, answers: BidAnswer[] = []) {
  const analysis = tender.analysis;
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer]));
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
    decision: analysis?.decision === "NO_GO" ? "NO-GO" : analysis?.decision ?? "REVIEW",
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
  };
}

export function serializePublicTender(tender: PublicTender, matchScore: number) {
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
  };
}

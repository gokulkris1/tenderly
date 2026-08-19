import OpenAI from "openai";
import type { BidAnswer, CompanyProfile, EvidenceRecord, PersonRecord, TenderAnalysis, TenderRecord } from "./types.js";

const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6";
const client = apiKey ? new OpenAI({ apiKey }) : null;

const evidenceSchema = {
  type: "object",
  properties: {
    sourceDocument: { type: "string" },
    quote: { type: "string" },
    confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
  },
  required: ["sourceDocument", "quote", "confidence"],
  additionalProperties: false,
} as const;

const analysisSchema = {
  type: "object",
  properties: {
    headline: { type: "string" },
    executiveSummary: { type: "string" },
    bidType: { type: "string", enum: ["OPEN_CONTRACT", "FRAMEWORK_ESTABLISHMENT", "FRAMEWORK_MINI_COMPETITION", "DPS", "RESTRICTED", "NEGOTIATED", "UNKNOWN"] },
    access: { type: "string", enum: ["OPEN_TO_QUALIFIED_BIDDERS", "FRAMEWORK_MEMBERS_ONLY", "INVITED_ONLY", "UNKNOWN"] },
    eligibility: { type: "string", enum: ["PASS", "FAIL", "REVIEW"] },
    fitScore: { type: "integer", minimum: 0, maximum: 100 },
    decision: { type: "string", enum: ["GO", "PARTNER", "REVIEW", "NO_GO"] },
    partnerNeeded: { type: "boolean" },
    partnerGaps: { type: "array", items: { type: "string" } },
    deadline: { type: "string" },
    clarificationDeadline: { type: "string" },
    contractValue: { type: "string" },
    duration: { type: "string" },
    lots: { type: "array", items: { type: "string" } },
    fatalGates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, requirement: { type: "string" }, bidderEvidence: { type: "string" }, status: { type: "string", enum: ["PASS", "REVIEW", "FAIL", "NOT_APPLICABLE"] }, action: { type: "string" }, evidence: evidenceSchema,
        },
        required: ["id", "requirement", "bidderEvidence", "status", "action", "evidence"], additionalProperties: false,
      },
    },
    evaluationCriteria: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, weight: { type: "number" }, minimumScore: { type: "number" }, strategy: { type: "string" }, evidence: evidenceSchema }, required: ["name", "weight", "minimumScore", "strategy", "evidence"], additionalProperties: false },
    },
    questions: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, prompt: { type: "string" }, weight: { type: "number" }, maxWords: { type: "integer" }, required: { type: "boolean" }, evidenceNeeded: { type: "array", items: { type: "string" } }, source: evidenceSchema }, required: ["id", "title", "prompt", "weight", "maxWords", "required", "evidenceNeeded", "source"], additionalProperties: false },
    },
    roles: {
      type: "array",
      items: { type: "object", properties: { role: { type: "string" }, quantity: { type: "integer" }, minimumExperience: { type: "string" }, qualifications: { type: "string" }, cvRequired: { type: "boolean" }, bidderMatch: { type: "string" }, status: { type: "string", enum: ["PASS", "REVIEW", "FAIL"] }, action: { type: "string" }, evidence: evidenceSchema }, required: ["role", "quantity", "minimumExperience", "qualifications", "cvRequired", "bidderMatch", "status", "action", "evidence"], additionalProperties: false },
    },
    clarificationQuestions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    submissionMethod: { type: "string" },
    submissionChecklist: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, required: { type: "boolean" }, kind: { type: "string", enum: ["RESPONSE", "BUYER_TEMPLATE", "SIGNATURE", "PRICING", "CV", "OTHER"] }, status: { type: "string", enum: ["READY", "ACTION", "VERIFY"] }, source: evidenceSchema }, required: ["id", "label", "required", "kind", "status", "source"], additionalProperties: false },
    },
    synopsisSlides: {
      type: "array", minItems: 1, maxItems: 3,
      items: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" }, maxItems: 7 } }, required: ["title", "bullets"], additionalProperties: false },
    },
  },
  required: ["headline", "executiveSummary", "bidType", "access", "eligibility", "fitScore", "decision", "partnerNeeded", "partnerGaps", "deadline", "clarificationDeadline", "contractValue", "duration", "lots", "fatalGates", "evaluationCriteria", "questions", "roles", "clarificationQuestions", "risks", "submissionMethod", "submissionChecklist", "synopsisSlides"],
  additionalProperties: false,
} as const;

const draftSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["DRAFTED", "NEEDS_INPUT"] },
    answer: { type: "string" },
    missingInputs: { type: "array", items: { type: "string" } },
    evidenceUsed: { type: "array", items: { type: "string" } },
    claimsToVerify: { type: "array", items: { type: "string" } },
  },
  required: ["status", "answer", "missingInputs", "evidenceUsed", "claimsToVerify"],
  additionalProperties: false,
} as const;

function sourceFallback(tender: TenderRecord, company: CompanyProfile): TenderAnalysis {
  const isOpen = /^open\b/i.test(tender.procedure);
  const framework = /framework/i.test(`${tender.title} ${tender.description}`);
  const establishment = /establish|establishment/i.test(`${tender.title} ${tender.description}`);
  const bidType = framework && establishment ? "FRAMEWORK_ESTABLISHMENT" : isOpen ? "OPEN_CONTRACT" : "UNKNOWN";
  const evidence = { sourceDocument: "eTenders notice", quote: tender.procedure ? `Procedure: ${tender.procedure}` : "", confidence: tender.procedure ? "MEDIUM" as const : "LOW" as const };
  return {
    headline: "Full AI qualification needs an OpenAI API key",
    executiveSummary: tender.description || "The opportunity was imported. Configure OPENAI_API_KEY to analyse the complete tender pack.",
    bidType,
    access: isOpen ? "OPEN_TO_QUALIFIED_BIDDERS" : "UNKNOWN",
    eligibility: "REVIEW",
    fitScore: 0,
    decision: "REVIEW",
    partnerNeeded: false,
    partnerGaps: [],
    deadline: tender.deadline,
    clarificationDeadline: "",
    contractValue: tender.estimatedValue,
    duration: "",
    lots: [],
    fatalGates: [{ id: "source-review", requirement: "Complete qualification review", bidderEvidence: company.services ? "Company profile loaded" : "Company profile incomplete", status: "REVIEW", action: "Configure OPENAI_API_KEY and re-run analysis", evidence }],
    evaluationCriteria: [], questions: [], roles: [], clarificationQuestions: [], risks: ["Full tender-document qualification has not run"],
    submissionMethod: "Verify in tender documents", submissionChecklist: [],
    synopsisSlides: [{ title: "Opportunity", bullets: [tender.title, tender.authority, `Deadline: ${tender.deadline || "not found"}`] }],
  };
}

export async function analyseTender(tender: TenderRecord, company: CompanyProfile, sourceText: string, bidderContext: { people?: PersonRecord[]; evidence?: EvidenceRecord[] } = {}): Promise<TenderAnalysis> {
  if (!client) return sourceFallback(tender, company);
  const instructions = `You are Tenderly's public-procurement bid qualification analyst. Your job is to decide what the supplied sources actually establish, not what is plausible.

SOURCE DISCIPLINE
- Treat the supplied eTenders notice, tender documents and bidder profile as the entire evidence set. Never invent a requirement, credential, deadline, weight, file, turnover threshold or bidder capability.
- Every decisive eligibility gate must include a short exact quote and the real source-document label. If the source is absent or ambiguous, status must be REVIEW; use an empty quote and say what must be checked.
- A missing bidder fact is REVIEW, not FAIL. FAIL is allowed only when the tender explicitly requires something and the bidder profile explicitly contradicts it or clearly cannot meet it.
- A source quote supports only the claim it actually contains. Prefer tender-document detail over the notice when they differ and flag the conflict.

FRAMEWORK / ACCESS RULE — CRITICAL
- Do NOT equate the word "framework" with a closed competition. A competition to ESTABLISH a framework can be open to qualified bidders.
- FRAMEWORK_MINI_COMPETITION / FRAMEWORK_MEMBERS_ONLY is only justified when the supplied source says the competition is under an existing framework/DPS/arrangement and participation is restricted to appointed/admitted/invited members.
- Distinguish open, restricted, negotiated and invitation-only procedures from framework structure.

BIDDER FIT
- Evaluate hard gates first: competition access, lot eligibility, turnover/financial thresholds, insurances, certifications/accreditations, exclusions, minimum references, location/legal form, security/quality standards, mandatory personnel and any stated pass/fail minimum.
- For every named/required role, match only against supplied bidderPeople CV facts. bidderMatch names the strongest evidenced person or says "No evidenced match". Missing/ambiguous CV proof is REVIEW; FAIL requires an explicit mismatch. action says what CV, qualification, partner or confirmation is still needed.
- Then calculate fitScore from 0–100 based on capability, evidence, team, commercial and delivery fit. Do not inflate incomplete profiles.
- decision: GO only when no fatal gate is FAIL and material gates are evidenced; PARTNER only when a concrete capability/capacity/credential gap can credibly be closed with a partner; NO_GO for a real access/mandatory mismatch or very poor fit; REVIEW when source/bidder evidence is insufficient.
- Never recommend a partner merely because the procurement is a framework.

RESPONSE / PACK
- Extract actual weighted criteria, marked questions, word/page limits, mandatory CV roles, pricing/declaration/template requirements and clarification deadline when present. Unknown numeric weights/limits must be 0, not guessed.
- submissionChecklist status is READY only when the provided source/bidder data already satisfies the item. Buyer templates, pricing schedules, declarations requiring signature, and CVs not supplied are ACTION or VERIFY.
- Build 1–3 synopsis slides maximum: opportunity; can/should we bid; how to win / next actions.

This is decision support. Be concise, conservative and evidence-grounded.`;

  const input = JSON.stringify({
    tender: { title: tender.title, authority: tender.authority, procedure: tender.procedure, deadline: tender.deadline, estimatedValue: tender.estimatedValue, sourceUrl: tender.sourceUrl, metadata: tender.metadata },
    bidderProfile: company,
    bidderPeople: bidderContext.people ?? [],
    approvedBidderEvidence: (bidderContext.evidence ?? []).filter((item) => item.verified),
    sources: sourceText,
  });

  const response = await client.responses.create({
    model,
    store: false,
    instructions,
    input,
    text: { format: { type: "json_schema", name: "tender_analysis", strict: true, schema: analysisSchema } },
  });
  if (!response.output_text) throw new Error("AI analysis returned no structured output");
  return JSON.parse(response.output_text) as TenderAnalysis;
}

export async function draftBidAnswer(args: {
  tender: TenderRecord;
  company: CompanyProfile;
  question: TenderAnalysis["questions"][number];
  evidence: EvidenceRecord[];
  people: PersonRecord[];
  existingAnswers: BidAnswer[];
}) {
  if (!client) return { status: "NEEDS_INPUT" as const, answer: "", missingInputs: ["Configure OPENAI_API_KEY to draft evidence-grounded bid responses"], evidenceUsed: [], claimsToVerify: [] };
  const instructions = `You are Tenderly's evidence-bound bid writer. Draft only from supplied bidder facts, verified evidence and CV facts. Never fabricate client names, metrics, accreditations, staff experience or outcomes. If a fact needed to answer the scored question is missing, list it in missingInputs and write a useful draft around verified facts with [INPUT NEEDED: ...] placeholders. Respect the stated maxWords when it is above zero. Address the exact question and its scoring emphasis. Do not claim that a draft is final or compliant. evidenceUsed must name only supplied items actually used. claimsToVerify lists statements that a human should confirm before submission.`;
  const payload = {
    tender: { title: args.tender.title, authority: args.tender.authority, analysis: args.tender.analysis },
    question: args.question,
    bidderProfile: args.company,
    approvedEvidence: args.evidence.filter((item) => item.verified),
    people: args.people,
    priorAnswers: args.existingAnswers.map((answer) => ({ questionId: answer.questionId, response: answer.response })),
  };
  const response = await client.responses.create({
    model,
    store: false,
    instructions,
    input: JSON.stringify(payload),
    text: { format: { type: "json_schema", name: "bid_answer_draft", strict: true, schema: draftSchema } },
  });
  if (!response.output_text) throw new Error("AI drafting returned no structured output");
  return JSON.parse(response.output_text) as { status: "DRAFTED" | "NEEDS_INPUT"; answer: string; missingInputs: string[]; evidenceUsed: string[]; claimsToVerify: string[] };
}

export function aiConfigured() { return Boolean(client); }

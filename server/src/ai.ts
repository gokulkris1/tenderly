import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { bidAnswerDraftSchema, tenderAnalysisSchema, type BidAnswerDraft } from "./ai-schemas.js";
import { withStableIds } from "./analysis-schema.js";
import type { BidAnswer, CompanyProfile, EvidenceRecord, PersonRecord, TenderAnalysis, TenderRecord } from "./types.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
/** Model is pinned by configuration, not by the caller. */
const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-fable-5";
const client = apiKey ? new Anthropic({ apiKey }) : null;

/**
 * Analysis returns a large structured object; drafting returns one answer.
 * Neither is streamed here — streaming drafting to the UI is TLY-68.
 *
 * 16000 is the SDK's ceiling for a non-streaming request: above it the client
 * refuses outright ("Streaming is required for operations that may take longer
 * than 10 minutes"). A full analysis is well inside this.
 */
const ANALYSIS_MAX_TOKENS = 16000;
const DRAFT_MAX_TOKENS = 16000;

/**
 * Structured output is expressed as a single forced tool call rather than
 * `output_config.format`. The analysis schema is large enough that a strict
 * grammar is rejected outright ("The compiled grammar is too large"), so the
 * schema travels as a tool input schema and the Zod schema validates the result.
 * That keeps one call per analysis and still fails loudly on a malformed payload.
 */
function forcedTool(name: string, description: string, schema: z.ZodType) {
  return {
    tool: { name, description, input_schema: z.toJSONSchema(schema) as Anthropic.Tool["input_schema"] },
    choice: { type: "tool" as const, name },
  };
}

/** Pulls the forced tool call out of a response and validates it. */
function parseToolResult<T>(response: Anthropic.Message, schema: z.ZodType<T>, what: string): T {
  if (response.stop_reason === "refusal") {
    throw new Error(`AI ${what} was declined (${response.stop_details?.category ?? "unspecified"})`);
  }
  const block = response.content.find((item) => item.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error(`AI ${what} returned no structured output`);
  const result = schema.safeParse(block.input);
  if (!result.success) {
    throw new Error(`AI ${what} did not match the expected shape: ${result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return result.data;
}

function sourceFallback(tender: TenderRecord, company: CompanyProfile): TenderAnalysis {
  const isOpen = /^open\b/i.test(tender.procedure);
  const framework = /framework/i.test(`${tender.title} ${tender.description}`);
  const establishment = /establish|establishment/i.test(`${tender.title} ${tender.description}`);
  const bidType = framework && establishment ? "FRAMEWORK_ESTABLISHMENT" : isOpen ? "OPEN_CONTRACT" : "UNKNOWN";
  const evidence = { sourceDocument: "eTenders notice", quote: tender.procedure ? `Procedure: ${tender.procedure}` : "", confidence: tender.procedure ? "MEDIUM" as const : "LOW" as const };
  return withStableIds({
    headline: "Full AI qualification needs an Anthropic API key",
    executiveSummary: tender.description || "The opportunity was imported. Configure ANTHROPIC_API_KEY to analyse the complete tender pack.",
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
    fatalGates: [{ id: "source-review", requirement: "Complete qualification review", bidderEvidence: company.services ? "Company profile loaded" : "Company profile incomplete", status: "REVIEW", action: "Configure ANTHROPIC_API_KEY and re-run analysis", evidence }],
    evaluationCriteria: [], questions: [], roles: [], clarificationQuestions: [], risks: ["Full tender-document qualification has not run"],
    submissionMethod: "Verify in tender documents", submissionChecklist: [],
    synopsisSlides: [{ title: "Opportunity", bullets: [tender.title, tender.authority, `Deadline: ${tender.deadline || "not found"}`] }],
  });
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

  const { tool, choice } = forcedTool("record_tender_analysis", "Record the complete qualification analysis of this tender.", tenderAnalysisSchema);
  const response = await client.messages.create({
    model,
    max_tokens: ANALYSIS_MAX_TOKENS,
    system: instructions,
    messages: [{ role: "user", content: input }],
    tools: [tool],
    tool_choice: choice,
    output_config: { effort: "high" },
  });
  // The model invents ids; replace them with ones derived from the questions themselves.
  return withStableIds(parseToolResult(response, tenderAnalysisSchema, "analysis") as TenderAnalysis);
}

export async function draftBidAnswer(args: {
  tender: TenderRecord;
  company: CompanyProfile;
  question: TenderAnalysis["questions"][number];
  evidence: EvidenceRecord[];
  people: PersonRecord[];
  existingAnswers: BidAnswer[];
}) {
  if (!client) return { status: "NEEDS_INPUT" as const, answer: "", missingInputs: ["Configure ANTHROPIC_API_KEY to draft evidence-grounded bid responses"], evidenceUsed: [], claimsToVerify: [] };
  const instructions = `You are Tenderly's evidence-bound bid writer. Draft only from supplied bidder facts, verified evidence and CV facts. Never fabricate client names, metrics, accreditations, staff experience or outcomes. If a fact needed to answer the scored question is missing, list it in missingInputs and write a useful draft around verified facts with [INPUT NEEDED: ...] placeholders. Respect the stated maxWords when it is above zero. Address the exact question and its scoring emphasis. Do not claim that a draft is final or compliant. evidenceUsed must name only supplied items actually used. claimsToVerify lists statements that a human should confirm before submission.`;
  const payload = {
    tender: { title: args.tender.title, authority: args.tender.authority, analysis: args.tender.analysis },
    question: args.question,
    bidderProfile: args.company,
    approvedEvidence: args.evidence.filter((item) => item.verified),
    people: args.people,
    priorAnswers: args.existingAnswers.map((answer) => ({ questionId: answer.questionId, response: answer.response })),
  };
  const { tool, choice } = forcedTool("record_bid_answer", "Record the drafted answer to this scored question.", bidAnswerDraftSchema);
  const response = await client.messages.create({
    model,
    max_tokens: DRAFT_MAX_TOKENS,
    system: instructions,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    tools: [tool],
    tool_choice: choice,
    output_config: { effort: "high" },
  });
  return parseToolResult(response, bidAnswerDraftSchema, "drafting") as BidAnswerDraft;
}

export function aiConfigured() { return Boolean(client); }

/** The configured model, so /health reports what is actually in use. */
export function aiModel() { return model; }

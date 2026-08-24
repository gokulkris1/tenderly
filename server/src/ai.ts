import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { answerCritiqueSchema, bidAnswerDraftSchema, cvExtractionSchema, decisionRationaleSchema, tenderAnalysisSchema, type BidAnswerDraft } from "./ai-schemas.js";
import { ANALYSIS_PROMPT, ANALYSIS_PROMPT_VERSION, CRITIQUE_PROMPT, CV_PROMPT, DRAFTING_PROMPT, RATIONALE_PROMPT } from "./prompts/index.js";
import { withStableIds } from "./analysis-schema.js";
import { reconcileGates, rollUpEligibility } from "./eligibility.js";
import { recordUsage } from "./db.js";
import type { BidAnswer, CompanyProfile, EvidenceRecord, PersonRecord, TenderAnalysis, TenderRecord, UsageEvent } from "./types.js";

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

/**
 * The one place a model call is made.
 *
 * Every capability goes through here so that no future call site can be added
 * without being metered — the meter is a property of the wrapper, not of each
 * caller remembering to write a row.
 *
 * Metering never blocks or fails the user's request: a lost row costs billing
 * accuracy, a failed request costs the user their work. Failures are logged.
 */
async function callModel(args: {
  kind: UsageEvent["kind"];
  accountId?: string;
  tenderId?: string;
  request: Anthropic.MessageCreateParamsNonStreaming;
}): Promise<Anthropic.Message> {
  const response = await client!.messages.create(args.request);
  if (args.accountId) {
    try {
      await recordUsage({
        accountId: args.accountId,
        kind: args.kind,
        model: args.request.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        requestId: response.id,
        tenderId: args.tenderId,
      });
    } catch (error) {
      console.error(`usage metering failed for ${args.kind}:`, error instanceof Error ? error.message : error);
    }
  }
  return response;
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
    fatalGates: [{ id: "source-review", requirement: "Complete qualification review", bidderEvidence: company.services ? "Company profile loaded" : "Company profile incomplete", status: "REVIEW", action: "Configure ANTHROPIC_API_KEY and re-run analysis", lotId: "", evidence }],
    evaluationCriteria: [], questions: [], roles: [], clarificationQuestions: [], risks: ["Full tender-document qualification has not run"],
    submissionMethod: "Verify in tender documents", formalities: [], requiredCertificates: [], submissionChecklist: [],
    // Nothing has read the pack, so nothing can be said about its AI policy.
    aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
    synopsisSlides: [{ title: "Opportunity", bullets: [tender.title, tender.authority, `Deadline: ${tender.deadline || "not found"}`] }],
  });
}

export async function analyseTender(tender: TenderRecord, company: CompanyProfile, sourceText: string, bidderContext: { people?: PersonRecord[]; evidence?: EvidenceRecord[] } = {}): Promise<TenderAnalysis> {
  if (!client) return sourceFallback(tender, company);
  const instructions = ANALYSIS_PROMPT;

  const input = JSON.stringify({
    tender: { title: tender.title, authority: tender.authority, procedure: tender.procedure, deadline: tender.deadline, estimatedValue: tender.estimatedValue, sourceUrl: tender.sourceUrl, metadata: tender.metadata },
    bidderProfile: company,
    bidderPeople: bidderContext.people ?? [],
    approvedBidderEvidence: (bidderContext.evidence ?? []).filter((item) => item.verified),
    sources: sourceText,
  });

  const { tool, choice } = forcedTool("record_tender_analysis", "Record the complete qualification analysis of this tender.", tenderAnalysisSchema);
  const response = await callModel({
    kind: "analysis", accountId: tender.accountId, tenderId: tender.id,
    request: {
      model,
      max_tokens: ANALYSIS_MAX_TOKENS,
      system: instructions,
      messages: [{ role: "user", content: input }],
      tools: [tool],
      tool_choice: choice,
      output_config: { effort: "high" },
    },
  });
  // The model invents ids; replace them with ones derived from the questions themselves.
  const analysis = parseToolResult(response, tenderAnalysisSchema, "analysis") as TenderAnalysis;
  // Hard gates are arithmetic, so they are decided in code rather than trusted
  // from the model. The model's extraction stands; only the verdict is redone.
  const { gates } = reconcileGates({
    gates: analysis.fatalGates,
    company,
    requiredCertificates: analysis.requiredCertificates,
    evidence: bidderContext.evidence ?? [],
  });
  return withStableIds({
    ...analysis,
    fatalGates: gates,
    eligibility: rollUpEligibility(gates),
    promptVersion: ANALYSIS_PROMPT_VERSION,
  });
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
  const instructions = DRAFTING_PROMPT;
  const payload = {
    tender: { title: args.tender.title, authority: args.tender.authority, analysis: args.tender.analysis },
    question: args.question,
    bidderProfile: args.company,
    approvedEvidence: args.evidence.filter((item) => item.verified),
    people: args.people,
    priorAnswers: args.existingAnswers.map((answer) => ({ questionId: answer.questionId, response: answer.response })),
  };
  const { tool, choice } = forcedTool("record_bid_answer", "Record the drafted answer to this scored question.", bidAnswerDraftSchema);
  const response = await callModel({
    kind: "draft", accountId: args.tender.accountId, tenderId: args.tender.id,
    request: {
      model,
      max_tokens: DRAFT_MAX_TOKENS,
      system: instructions,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
      tools: [tool],
      tool_choice: choice,
      output_config: { effort: "high" },
    },
  });
  return parseToolResult(response, bidAnswerDraftSchema, "drafting") as BidAnswerDraft;
}

/**
 * Critiques an answer a person wrote. This is the one model capability that
 * survives no-AI mode: judging text is assistance, writing it is generation.
 * The forced schema has no prose field, so a replacement answer cannot come back
 * even if the model tried to offer one.
 */
export async function critiqueBidAnswer(args: {
  tender: TenderRecord;
  question: TenderAnalysis["questions"][number];
  answer: string;
  evidence: EvidenceRecord[];
}) {
  if (!client) {
    return { strengths: [], gaps: ["Configure ANTHROPIC_API_KEY to critique this answer"], missingEvidence: [] };
  }
  const payload = {
    question: args.question,
    awardCriteria: args.tender.analysis?.evaluationCriteria ?? [],
    answer: args.answer,
    approvedEvidence: args.evidence.filter((item) => item.verified).map((item) => ({ name: item.name, kind: item.kind })),
  };
  const { tool, choice } = forcedTool("record_answer_critique", "Record a critique of the answer the bidder wrote. Never supply replacement prose.", answerCritiqueSchema);
  const response = await callModel({
    kind: "critique", accountId: args.tender.accountId, tenderId: args.tender.id,
    request: {
      model,
      max_tokens: DRAFT_MAX_TOKENS,
      system: CRITIQUE_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
      tools: [tool],
      tool_choice: choice,
      output_config: { effort: "high" },
    },
  });
  return parseToolResult(response, answerCritiqueSchema, "critique");
}

/**
 * Writes the prose for a recommendation the rules already made.
 *
 * Returns null rather than throwing when there is no key or the call fails: the
 * band is deterministic and must still be shown, with the rationale marked
 * unavailable. A missing explanation is a smaller loss than a missing verdict.
 */
export async function draftDecisionRationale(args: {
  accountId: string;
  tenderId: string;
  decision: string;
  reason: string;
  facts: string[];
}): Promise<string | null> {
  if (!client) return null;
  const { tool, choice } = forcedTool("record_decision_rationale", "Explain a bid recommendation using only the facts supplied.", decisionRationaleSchema);
  try {
    const response = await callModel({
      kind: "critique", accountId: args.accountId, tenderId: args.tenderId,
      request: {
        model,
        max_tokens: 2000,
        system: RATIONALE_PROMPT,
        messages: [{ role: "user", content: JSON.stringify({ decision: args.decision, reason: args.reason, facts: args.facts }) }],
        tools: [tool],
        tool_choice: choice,
        output_config: { effort: "low" },
      },
    });
    return parseToolResult(response, decisionRationaleSchema, "rationale").rationale;
  } catch (error) {
    console.error("decision rationale failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Reads a CV into structured records.
 *
 * The text arrives inside the same untrusted-document envelope a tender pack
 * uses: a CV is a file someone else wrote, and is exactly where an instruction
 * would be smuggled in.
 *
 * Returns empty lists rather than throwing when there is no key, so uploading a
 * CV still works — it simply produces nothing to review yet.
 */
export async function extractCvRecords(args: {
  accountId: string;
  envelopedText: string;
}) {
  const empty = { skills: [], roles: [], certifications: [], experience: [] };
  if (!client) return empty;
  const { tool, choice } = forcedTool("record_cv_facts", "Record only what the CV actually says about this person.", cvExtractionSchema);
  try {
    const response = await callModel({
      kind: "critique", accountId: args.accountId,
      request: {
        model,
        max_tokens: DRAFT_MAX_TOKENS,
        system: CV_PROMPT,
        messages: [{ role: "user", content: args.envelopedText }],
        tools: [tool],
        tool_choice: choice,
        output_config: { effort: "medium" },
      },
    });
    return parseToolResult(response, cvExtractionSchema, "CV extraction");
  } catch (error) {
    console.error("CV extraction failed:", error instanceof Error ? error.message : error);
    return empty;
  }
}

export function aiConfigured() { return Boolean(client); }

/** The configured model, so /health reports what is actually in use. */
export function aiModel() { return model; }

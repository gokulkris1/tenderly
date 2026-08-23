import { z } from "zod";

/**
 * Zod mirrors of the analysis and drafting payloads.
 *
 * These are the model's output contract. Before TLY-64 the model's JSON was cast
 * to TenderAnalysis without being checked, so a malformed or partial response
 * became a "valid" analysis and flowed into eligibility gates and the pack. These
 * schemas are handed to the API as the structured-output format *and* validate
 * the response, so a payload that does not match is a caught error rather than a
 * silently wrong recommendation.
 */

export const sourceEvidenceSchema = z.object({
  sourceDocument: z.string(),
  quote: z.string(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
});

export const eligibilityGateSchema = z.object({
  id: z.string(),
  requirement: z.string(),
  bidderEvidence: z.string(),
  status: z.enum(["PASS", "REVIEW", "FAIL", "NOT_APPLICABLE"]),
  action: z.string(),
  evidence: sourceEvidenceSchema,
});

export const evaluationCriterionSchema = z.object({
  name: z.string(),
  /** Normalised to a percentage of the total award. 0 when the pack does not say. */
  weight: z.number(),
  /** The weighting exactly as the pack expresses it: "600 points", "60%", "". */
  rawWeight: z.string(),
  minimumScore: z.number(),
  strategy: z.string(),
  /** LOW when the stated weightings do not add up, or the figure was inferred. */
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  evidence: sourceEvidenceSchema,
});

export const analysisQuestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  weight: z.number(),
  maxWords: z.number().int(),
  required: z.boolean(),
  evidenceNeeded: z.array(z.string()),
  source: sourceEvidenceSchema,
});

export const requiredRoleSchema = z.object({
  role: z.string(),
  quantity: z.number().int(),
  minimumExperience: z.string(),
  qualifications: z.string(),
  cvRequired: z.boolean(),
  bidderMatch: z.string(),
  status: z.enum(["PASS", "REVIEW", "FAIL"]),
  action: z.string(),
  evidence: sourceEvidenceSchema,
});

export const submissionFormalitySchema = z.object({
  rule: z.string(),
  appliesTo: z.string(),
  evidence: sourceEvidenceSchema,
});

export const requiredCertificateSchema = z.object({
  name: z.string(),
  issuingBody: z.string(),
  mandatory: z.boolean(),
  evidence: sourceEvidenceSchema,
});

export const submissionChecklistItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  required: z.boolean(),
  kind: z.enum(["RESPONSE", "BUYER_TEMPLATE", "SIGNATURE", "PRICING", "CV", "OTHER"]),
  status: z.enum(["READY", "ACTION", "VERIFY"]),
  source: sourceEvidenceSchema,
});

export const tenderAnalysisSchema = z.object({
  headline: z.string(),
  executiveSummary: z.string(),
  bidType: z.enum([
    "OPEN_CONTRACT",
    "FRAMEWORK_ESTABLISHMENT",
    "FRAMEWORK_MINI_COMPETITION",
    "DPS",
    "RESTRICTED",
    "NEGOTIATED",
    "UNKNOWN",
  ]),
  access: z.enum(["OPEN_TO_QUALIFIED_BIDDERS", "FRAMEWORK_MEMBERS_ONLY", "INVITED_ONLY", "UNKNOWN"]),
  eligibility: z.enum(["PASS", "FAIL", "REVIEW"]),
  fitScore: z.number().int().min(0).max(100),
  decision: z.enum(["GO", "PARTNER", "REVIEW", "NO_GO"]),
  partnerNeeded: z.boolean(),
  partnerGaps: z.array(z.string()),
  deadline: z.string(),
  clarificationDeadline: z.string(),
  contractValue: z.string(),
  duration: z.string(),
  lots: z.array(z.string()),
  fatalGates: z.array(eligibilityGateSchema),
  evaluationCriteria: z.array(evaluationCriterionSchema),
  questions: z.array(analysisQuestionSchema),
  roles: z.array(requiredRoleSchema),
  clarificationQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  submissionMethod: z.string(),
  formalities: z.array(submissionFormalitySchema),
  requiredCertificates: z.array(requiredCertificateSchema),
  submissionChecklist: z.array(submissionChecklistItemSchema),
  synopsisSlides: z.array(z.object({ title: z.string(), bullets: z.array(z.string()) })),
});

export const bidAnswerDraftSchema = z.object({
  status: z.enum(["DRAFTED", "NEEDS_INPUT"]),
  answer: z.string(),
  /** Facts the tender needs that the bidder has not supplied. Drives [INPUT NEEDED]. */
  missingInputs: z.array(z.string()),
  /** Only items actually used, named exactly as supplied. */
  evidenceUsed: z.array(z.string()),
  /** Statements a human must confirm before submission. */
  claimsToVerify: z.array(z.string()),
});

export type BidAnswerDraft = z.infer<typeof bidAnswerDraftSchema>;

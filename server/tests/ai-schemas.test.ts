import assert from "node:assert/strict";
import test from "node:test";
import { bidAnswerDraftSchema, tenderAnalysisSchema } from "../src/ai-schemas.js";

const evidence = { sourceDocument: "RFT.docx", quote: "Tenderers shall hold a current Tax Clearance Certificate.", confidence: "HIGH" };

const validAnalysis = {
  headline: "Strong fit", executiveSummary: "Open competition.", bidType: "OPEN_CONTRACT",
  access: "OPEN_TO_QUALIFIED_BIDDERS", eligibility: "REVIEW", fitScore: 72, decision: "REVIEW",
  partnerNeeded: false, partnerGaps: [], deadline: "26/03/2026 12:00", clarificationDeadline: "",
  contractValue: "EUR 450,000", duration: "", lots: [],
  fatalGates: [{ id: "tax", requirement: "Tax clearance", bidderEvidence: "None recorded", status: "REVIEW", action: "Upload certificate", evidence }],
  evaluationCriteria: [], questions: [], roles: [], clarificationQuestions: [], risks: [],
  submissionMethod: "eTenders", formalities: [], requiredCertificates: [], submissionChecklist: [], synopsisSlides: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
};

test("TLY-64: a well-formed analysis validates", () => {
  const result = tenderAnalysisSchema.safeParse(validAnalysis);
  assert.equal(result.success, true);
});

test("TLY-64: a gate status the domain does not define is rejected", () => {
  // Before this story the model's JSON was cast, so an invented status flowed
  // straight into eligibility and the pack gate.
  const bad = { ...validAnalysis, fatalGates: [{ ...validAnalysis.fatalGates[0], status: "PROBABLY_FINE" }] };
  const result = tenderAnalysisSchema.safeParse(bad);
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error?.issues), /fatalGates/);
});

test("TLY-64: a missing required section is rejected rather than defaulted", () => {
  const { submissionChecklist: _dropped, ...missing } = validAnalysis;
  assert.equal(tenderAnalysisSchema.safeParse(missing).success, false);
});

test("TLY-64: a fit score outside 0-100 is rejected", () => {
  assert.equal(tenderAnalysisSchema.safeParse({ ...validAnalysis, fitScore: 140 }).success, false);
});

test("TLY-64: a draft must declare its status and its missing inputs", () => {
  assert.equal(bidAnswerDraftSchema.safeParse({
    status: "NEEDS_INPUT", answer: "Draft with [INPUT NEEDED: annual turnover].",
    missingInputs: ["annual turnover"], evidenceUsed: [], claimsToVerify: [],
  }).success, true);
  // A draft that omits missingInputs would let an unevidenced answer look complete.
  assert.equal(bidAnswerDraftSchema.safeParse({ status: "DRAFTED", answer: "All good.", evidenceUsed: [], claimsToVerify: [] }).success, false);
});

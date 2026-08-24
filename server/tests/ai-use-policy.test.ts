import assert from "node:assert/strict";
import test from "node:test";
import { aiUsePolicy, serializeTender } from "../src/serializers.js";
import { withStableIds } from "../src/analysis-schema.js";
import { ANALYSIS_PROMPT } from "../src/prompts/index.js";
import { tenderAnalysisSchema } from "../src/ai-schemas.js";
import type { AiUsePolicy, TenderAnalysis, TenderRecord } from "../src/types.js";

const base = { id: "t", accountId: "a", source: "etenders", externalId: "X", title: "T", authority: "A",
  procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {} } as unknown as TenderRecord;

const analysisWith = (policy?: AiUsePolicy): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "", clarificationDeadline: "", contractValue: "", duration: "", lots: [], fatalGates: [],
  evaluationCriteria: [], questions: [], roles: [], clarificationQuestions: [], risks: [],
  submissionMethod: "", formalities: [], requiredCertificates: [], aiUsePolicy: policy,
  submissionChecklist: [], synopsisSlides: [],
});

const prohibited: AiUsePolicy = {
  state: "prohibited",
  evidence: { sourceDocument: "ITT.pdf", quote: "Responses generated using artificial intelligence will be rejected.", confidence: "HIGH" },
};

test("TLY-74 AC1: a prohibition reaches the wire with the quoted sentence and its document", () => {
  const wire = serializeTender({ ...base, analysis: analysisWith(prohibited) } as TenderRecord, []);
  assert.equal(wire.aiUsePolicy?.state, "prohibited");
  assert.equal(wire.aiUsePolicy?.quote, "Responses generated using artificial intelligence will be rejected.");
  assert.equal(wire.aiUsePolicy?.source, "ITT.pdf");
  assert.equal(wire.aiUsePolicy?.confidence, "HIGH");
});

test("TLY-74 AC2: a disclosure requirement is carried as its own state", () => {
  const policy: AiUsePolicy = { state: "disclosure-required",
    evidence: { sourceDocument: "RFT.pdf", quote: "Tenderers shall declare any use of AI tools.", confidence: "HIGH" } };
  const wire = serializeTender({ ...base, analysis: analysisWith(policy) } as TenderRecord, []);
  assert.equal(wire.aiUsePolicy?.state, "disclosure-required");
  assert.equal(wire.aiUsePolicy?.quote, "Tenderers shall declare any use of AI tools.");
});

test("TLY-74 AC3: a silent pack is not-stated, and no prohibition is asserted", () => {
  const policy: AiUsePolicy = { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } };
  const wire = serializeTender({ ...base, analysis: analysisWith(policy) } as TenderRecord, []);
  assert.equal(wire.aiUsePolicy?.state, "not-stated");
  assert.equal(wire.aiUsePolicy?.quote, "", "nothing may be quoted when the pack says nothing");
});

test("TLY-74: an analysis from before this field reads as not-stated, never unrestricted", () => {
  const wire = serializeTender({ ...base, analysis: analysisWith(undefined) } as TenderRecord, []);
  assert.equal(wire.aiUsePolicy?.state, "not-stated");
  assert.notEqual(wire.aiUsePolicy?.state, "unrestricted", "silence is not permission");
  assert.equal(aiUsePolicy(undefined, undefined).confidence, "LOW");
});

test("TLY-74 AC5: dismissing records the user and the time without altering what was found", () => {
  const acknowledgement = { action: "dismissed" as const, actor: "tester@example.test", at: "2026-08-24T10:00:00.000Z" };
  const wire = serializeTender(
    { ...base, analysis: analysisWith(prohibited), metadata: { aiPolicyAcknowledgement: acknowledgement } } as TenderRecord, []);
  assert.deepEqual(wire.aiUsePolicy?.acknowledgement, acknowledgement);
  assert.equal(wire.aiUsePolicy?.state, "prohibited", "dismissing the flag does not change what the pack says");
});

test("TLY-74: the analysis prompt tells the model that silence is not permission", () => {
  assert.match(ANALYSIS_PROMPT, /AI USE POLICY/);
  assert.match(ANALYSIS_PROMPT, /Silence is NOT permission/);
  assert.match(ANALYSIS_PROMPT, /never return "unrestricted" for a pack that is simply silent/);
});

test("TLY-74: the model must return a policy, and only from the four known states", () => {
  const shape = tenderAnalysisSchema.shape.aiUsePolicy;
  assert.ok(shape, "aiUsePolicy is part of the structured output the model must fill");
  const valid = shape.safeParse({ state: "prohibited", evidence: { sourceDocument: "ITT.pdf", quote: "q", confidence: "HIGH" } });
  assert.ok(valid.success);
  const invalid = shape.safeParse({ state: "probably-fine", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } });
  assert.equal(invalid.success, false, "an invented state must fail validation rather than reach the user");
});

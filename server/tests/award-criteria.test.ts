import assert from "node:assert/strict";
import test from "node:test";
import { awardCriteriaWarning, serializeTender } from "../src/serializers.js";
import { withStableIds } from "../src/analysis-schema.js";
import { ANALYSIS_PROMPT } from "../src/prompts/index.js";
import type { TenderAnalysis, TenderRecord } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "Quality 60%, Price 40%.", confidence: "HIGH" as const };
const criterion = (name: string, weight: number, rawWeight: string, confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH") =>
  ({ name, weight, rawWeight, minimumScore: 0, strategy: "", confidence, evidence });

const base = { id: "t", accountId: "a", source: "etenders", externalId: "X", title: "T", authority: "A",
  procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {} } as unknown as TenderRecord;

const analysisWith = (criteria: TenderAnalysis["evaluationCriteria"]): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "", clarificationDeadline: "", contractValue: "", duration: "", lots: [], fatalGates: [],
  evaluationCriteria: criteria, questions: [], roles: [], clarificationQuestions: [], risks: [],
  submissionMethod: "", submissionChecklist: [], synopsisSlides: [],
});

test("TLY-42 AC1: criteria reach the wire with their weight and source quote", () => {
  const wire = serializeTender({ ...base, analysis: analysisWith([criterion("Quality", 60, "60%"), criterion("Price", 40, "40%")]) } as TenderRecord, []);
  assert.equal(wire.awardCriteria?.length, 2);
  assert.deepEqual(wire.awardCriteria?.map((c) => [c.name, c.weight]), [["Quality", 60], ["Price", 40]]);
  assert.equal(wire.awardCriteria?.[0].quote, "Quality 60%, Price 40%.");
  assert.equal(wire.awardCriteria?.[0].source, "ITT.pdf");
  assert.equal(wire.awardCriteriaWarning, undefined);
});

test("TLY-42 AC2: a points-based scheme is normalised but keeps its raw wording", () => {
  const wire = serializeTender({ ...base, analysis: analysisWith([criterion("Quality", 60, "600 points"), criterion("Price", 40, "400 points")]) } as TenderRecord, []);
  assert.deepEqual(wire.awardCriteria?.map((c) => c.rawWeight), ["600 points", "400 points"]);
  assert.deepEqual(wire.awardCriteria?.map((c) => c.weight), [60, 40]);
});

test("TLY-42 AC3: weightings that do not add up are reported as stated, not rescaled", () => {
  const criteria = [criterion("Quality", 50, "50%", "LOW"), criterion("Price", 40, "40%", "LOW")];
  const wire = serializeTender({ ...base, analysis: analysisWith(criteria) } as TenderRecord, []);
  assert.equal(wire.awardCriteriaWarning, "Stated weightings sum to 90%");
  // The stated values survive: rescaling would hide a defect in the buyer's pack.
  assert.deepEqual(wire.awardCriteria?.map((c) => c.weight), [50, 40]);
  assert.ok(wire.awardCriteria?.every((c) => c.confidence === "LOW"));
});

test("TLY-42 AC4: a pack with no award criteria yields none, and nothing is invented", () => {
  const wire = serializeTender({ ...base, analysis: analysisWith([]) } as TenderRecord, []);
  assert.deepEqual(wire.awardCriteria, []);
  assert.equal(wire.awardCriteriaWarning, undefined);
});

test("TLY-42: the warning helper only fires on a real mismatch", () => {
  assert.equal(awardCriteriaWarning([]), undefined);
  assert.equal(awardCriteriaWarning([{ weight: 100 }]), undefined);
  assert.equal(awardCriteriaWarning([{ weight: 70 }, { weight: 30 }]), undefined);
  assert.equal(awardCriteriaWarning([{ weight: 70 }, { weight: 40 }]), "Stated weightings sum to 110%");
});

test("TLY-42: the prompt forbids silently rescaling weightings", () => {
  assert.match(ANALYSIS_PROMPT, /Do NOT rescale stated weightings/i);
  assert.match(ANALYSIS_PROMPT, /Never invent a weighting/i);
});

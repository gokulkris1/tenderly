import assert from "node:assert/strict";
import test from "node:test";
import { NO_CHANGES, describeChange, diffAnalyses, questionsNeedingReview } from "../src/analysis-diff.js";
import { serializeTender } from "../src/serializers.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { BidAnswer, TenderAnalysis, TenderRecord } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };

const analysis = (over: Partial<TenderAnalysis> = {}): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "12/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [{ id: "tax", requirement: "Tax clearance", bidderEvidence: "", status: "REVIEW", action: "", lotId: "", evidence: source }],
  evaluationCriteria: [
    { name: "Quality", weight: 60, rawWeight: "60%", minimumScore: 0, strategy: "", confidence: "HIGH", evidence: source },
    { name: "Price", weight: 40, rawWeight: "40%", minimumScore: 0, strategy: "", confidence: "HIGH", evidence: source },
  ],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe your delivery methodology.", weight: 60, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
  ...over,
});

test("TLY-45 AC4: an identical re-analysis reports nothing", () => {
  assert.deepEqual(diffAnalyses(analysis(), analysis()), []);
  assert.equal(NO_CHANGES, "No changes since the previous analysis");
});

test("TLY-45 AC2: a moved deadline shows both dates", () => {
  const changes = diffAnalyses(analysis(), analysis({ deadline: "26/03/2027" }));
  const deadline = changes.find((change) => change.kind === "deadline");
  assert.ok(deadline);
  assert.equal(describeChange(deadline), "Deadline moved from 12/03/2027 to 26/03/2027");
});

test("TLY-45 AC1: added and removed questions are both reported", () => {
  const before = analysis();
  const after = analysis({
    questions: [
      ...before.questions,
      { id: "extra", title: "Social value", prompt: "Describe your social value offer.", weight: 10, maxWords: 300, required: true, evidenceNeeded: [], lotId: "", source },
    ],
  });

  const added = diffAnalyses(before, after);
  assert.ok(added.some((change) => change.kind === "question-added" && change.title === "Social value"));

  const removed = diffAnalyses(after, before);
  assert.ok(removed.some((change) => change.kind === "question-removed" && change.title === "Social value"));
});

test("TLY-45 AC1: a changed gate status is reported, not a removal and an addition", () => {
  const before = analysis();
  const after = analysis({
    fatalGates: [{ id: "tax", requirement: "Tax clearance", bidderEvidence: "", status: "FAIL", action: "", lotId: "", evidence: source }],
  });
  const changes = diffAnalyses(before, after);
  const gate = changes.find((change) => change.kind === "gate-status");
  assert.equal(describeChange(gate!), "Tax clearance: REVIEW → FAIL");
  assert.ok(!changes.some((change) => change.kind === "gate-removed"), "the same requirement is one gate, not two");
});

test("TLY-45: a reweighted criterion is reported with both weights", () => {
  const after = analysis({
    evaluationCriteria: [
      { name: "Quality", weight: 70, rawWeight: "70%", minimumScore: 0, strategy: "", confidence: "HIGH", evidence: source },
      { name: "Price", weight: 30, rawWeight: "30%", minimumScore: 0, strategy: "", confidence: "HIGH", evidence: source },
    ],
  });
  const changes = diffAnalyses(analysis(), after);
  assert.ok(changes.some((change) => describeChange(change) === "Quality reweighted from 60% to 70%"));
  assert.ok(changes.some((change) => describeChange(change) === "Price reweighted from 40% to 30%"));
});

test("TLY-45 AC3: a materially changed question is flagged for review", () => {
  const before = analysis();
  const after = analysis({
    questions: [{ ...before.questions[0], prompt: "Describe your delivery methodology and your social value commitments." }],
  });

  const changes = diffAnalyses(before, after);
  const changed = changes.find((change) => change.kind === "question-changed");
  assert.ok(changed, "a reworded question is a change to that question, not a removal and an addition");
  assert.deepEqual(questionsNeedingReview(changes), [before.questions[0].id]);
});

test("TLY-45: rewrapping a prompt is not a material change", () => {
  const before = analysis();
  const after = analysis({
    questions: [{ ...before.questions[0], prompt: "Describe your   delivery\nmethodology." }],
  });
  assert.deepEqual(diffAnalyses(before, after), [], "a panel full of noise is one nobody reads");
});

test("TLY-45 AC3: the flagged answer is kept and marked, not discarded", () => {
  const stored = analysis();
  const questionId = stored.questions[0].id;
  const answers: BidAnswer[] = [{ id: "a1", tenderId: "t", questionId, response: "Our written approach.", status: "ready", evidence: [] }];
  const record = {
    id: "t", accountId: "a", source: "seed", externalId: "X", title: "T", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", analysis: stored,
    metadata: { questionsNeedingReview: [questionId] },
  } as unknown as TenderRecord;

  const wire = serializeTender(record, answers, []);
  const question = wire.questions[0];
  assert.equal(question.status, "needs-review");
  assert.equal(question.answer, "Our written approach.", "the work a person did is not thrown away");
  assert.match(question.reviewNote ?? "", /amended this question/);
});

test("TLY-45: an empty answer to an amended question is not flagged", () => {
  const stored = analysis();
  const questionId = stored.questions[0].id;
  const record = {
    id: "t", accountId: "a", source: "seed", externalId: "X", title: "T", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", analysis: stored,
    metadata: { questionsNeedingReview: [questionId] },
  } as unknown as TenderRecord;

  const wire = serializeTender(record, [], []);
  assert.equal(wire.questions[0].status, "draft", "there is nothing written to review");
  assert.equal(wire.questions[0].reviewNote, undefined);
});

test("TLY-45: a first analysis has nothing to compare against", () => {
  assert.deepEqual(diffAnalyses(null, analysis()), [],
    "a tender analysed once has not changed; it has only been analysed");
});

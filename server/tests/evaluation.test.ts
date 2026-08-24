import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listMockEvaluations, recordMockEvaluation, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { ESTIMATE_NOTICE, prioritisedGaps, scoreEvaluation } from "../src/evaluation.js";
import { EVALUATION_PROMPT } from "../src/prompts/index.js";
import { mockEvaluationSchema } from "../src/ai-schemas.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { EvaluationCriterion, TenderAnalysis } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Quality 60%, Price 40%.", confidence: "HIGH" as const };
const criterion = (name: string, weight: number): EvaluationCriterion =>
  ({ name, weight, rawWeight: `${weight}%`, minimumScore: 0, strategy: "", confidence: "HIGH", evidence: source });

const analysis = (criteria: EvaluationCriterion[]): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "PASS", fitScore: 70, decision: "GO", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: criteria,
  questions: [{ id: "q", title: "Methodology", prompt: "Describe it.", weight: 60, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
});

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const email = `eval-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Evaluating Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, email })}`, "content-type": "application/json" };

let counter = 0;
async function makeTender(criteria: EvaluationCriterion[]) {
  counter += 1;
  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `eval-${Date.now()}-${counter}`, title: `Evaluated tender ${counter}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(user.id, tender.id, analysis(criteria));
  return tender.id;
}

test("TLY-78 AC1: each criterion carries its mark, reasoning and weighted contribution", () => {
  const criteria = [criterion("Quality", 60), criterion("Price", 40)];
  const { criteria: scored, total } = scoreEvaluation([
    { name: "Quality", mark: 70, maximum: 100, reasoning: "Evidenced approach.", gap: "No named delivery lead.", questionId: "q" },
    { name: "Price", mark: 90, maximum: 100, reasoning: "Competitive.", gap: "", questionId: "" },
  ], criteria);

  assert.equal(scored.length, 2);
  const quality = scored.find((entry) => entry.name === "Quality")!;
  assert.equal(quality.mark, 70);
  assert.equal(quality.maximum, 100);
  assert.equal(quality.weightedContribution, 42, "70% of a 60-point criterion");
  assert.equal(total, 78, "42 from quality plus 36 from price");
});

test("TLY-78 AC2: the estimate is never presented as a prediction", () => {
  assert.match(ESTIMATE_NOTICE, /internal estimate/i);
  assert.match(ESTIMATE_NOTICE, /not a prediction/i);
  assert.match(EVALUATION_PROMPT, /Never present the score as a prediction/);
});

test("TLY-78 AC3: a criterion below half marks is flagged and points at the answer", () => {
  const criteria = [criterion("Quality", 60), criterion("Price", 40)];
  const { criteria: scored } = scoreEvaluation([
    { name: "Quality", mark: 30, maximum: 100, reasoning: "Little evidence.", gap: "No delivery method described.", questionId: "q" },
    { name: "Price", mark: 80, maximum: 100, reasoning: "Fine.", gap: "", questionId: "" },
  ], criteria);

  const quality = scored.find((entry) => entry.name === "Quality")!;
  assert.equal(quality.belowHalf, true);
  assert.equal(quality.questionId, "q", "so the UI can link to the answer that caused it");

  const gaps = prioritisedGaps(scored, criteria);
  assert.equal(gaps[0].criterion, "Quality", "worst first: the work list");
  assert.equal(gaps[0].marksLost, 42, "60 weight minus the 18 earned");
});

test("TLY-78 AC4: no extracted criteria means no score at all", async () => {
  const tenderId = await makeTender([]);
  const response = await fetch(`${base}/api/tenders/${tenderId}/mock-evaluation`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 409);
  const body = await response.json() as { error: string; notice: string };
  assert.equal(body.error, "No award criteria extracted");
  assert.equal(body.notice, ESTIMATE_NOTICE, "and it still says what a score would have meant");
});

test("TLY-78 AC5: the schema has nowhere to put replacement prose", () => {
  const shape = mockEvaluationSchema.shape.criteria.element.shape;
  assert.deepEqual(Object.keys(shape).sort(),
    ["gap", "mark", "maximum", "name", "questionId", "reasoning"],
    "a field carrying wording would smuggle generation into a no-AI tender");
  assert.match(EVALUATION_PROMPT, /Never supply replacement prose/);
  assert.match(EVALUATION_PROMPT, /Describe the weakness; do not fill it/);
});

test("TLY-78 AC6: runs accumulate, so the movement between them is visible", async () => {
  const tenderId = await makeTender([criterion("Quality", 60), criterion("Price", 40)]);
  await recordMockEvaluation({
    tenderId, actor: email, total: 55,
    criteria: [{ name: "Quality", mark: 30, maximum: 100, reasoning: "Thin.", gap: "No method.", questionId: "q", weightedContribution: 18, belowHalf: true }],
  });
  await recordMockEvaluation({
    tenderId, actor: email, total: 78,
    criteria: [{ name: "Quality", mark: 70, maximum: 100, reasoning: "Better.", gap: "", questionId: "", weightedContribution: 42, belowHalf: false }],
  });

  const runs = await listMockEvaluations(tenderId);
  assert.equal(runs.length, 2, "both runs are listed");
  assert.equal(Number(runs[0].total), 78, "newest first");
  assert.equal(Number(runs[1].total), 55);

  const response = await fetch(`${base}/api/tenders/${tenderId}/mock-evaluation`, { headers });
  const body = await response.json() as { evaluations: { total: number }[]; notice: string };
  assert.equal(body.evaluations.length, 2);
  assert.equal(body.notice, ESTIMATE_NOTICE);
});

test("TLY-78: a criterion the pack never stated is dropped, not given an invented weight", () => {
  const { criteria: scored, total } = scoreEvaluation([
    { name: "Quality", mark: 80, maximum: 100, reasoning: "", gap: "", questionId: "" },
    { name: "Social value", mark: 100, maximum: 100, reasoning: "", gap: "", questionId: "" },
  ], [criterion("Quality", 60)]);

  assert.deepEqual(scored.map((entry) => entry.name), ["Quality"]);
  assert.equal(total, 48, "the invented criterion contributes nothing");
});

test("TLY-78: a mark outside its maximum is clamped rather than trusted", () => {
  const { criteria: scored } = scoreEvaluation([
    { name: "Quality", mark: 140, maximum: 100, reasoning: "", gap: "", questionId: "" },
  ], [criterion("Quality", 60)]);
  assert.equal(scored[0].mark, 100);
  assert.equal(scored[0].weightedContribution, 60, "and cannot exceed the criterion's weight");

  const negative = scoreEvaluation([
    { name: "Quality", mark: -20, maximum: 100, reasoning: "", gap: "", questionId: "" },
  ], [criterion("Quality", 60)]);
  assert.equal(negative.criteria[0].mark, 0);
});

test("TLY-78: the evaluation is not readable across accounts", async () => {
  const tenderId = await makeTender([criterion("Quality", 100)]);
  const otherEmail = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = { authorization: `Bearer ${signToken({ id: other.id, email: otherEmail })}`, "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/tenders/${tenderId}/mock-evaluation`, { headers: otherHeaders })).status, 404);
  assert.equal((await fetch(`${base}/api/tenders/${tenderId}/mock-evaluation`, { method: "POST", headers: otherHeaders, body: "{}" })).status, 404);
});

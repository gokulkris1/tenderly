import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listAnswers, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import { serializeTender } from "../src/serializers.js";
import { answerCritiqueSchema } from "../src/ai-schemas.js";
import { CRITIQUE_PROMPT } from "../src/prompts/index.js";
import type { TenderAnalysis, TenderRecord } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [{ id: "g", requirement: "Tax clearance", bidderEvidence: "Not recorded", status: "REVIEW", action: "Upload it", evidence: source }],
  evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "prohibited", evidence: { sourceDocument: "ITT.pdf", quote: "Responses generated using artificial intelligence will be rejected.", confidence: "HIGH" } },
  submissionChecklist: [{ id: "seed", label: "Tender response", required: true, kind: "RESPONSE", status: "ACTION", source }],
  synopsisSlides: [],
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

const email = `noai-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "No AI Ltd");
const token = signToken({ id: user.id, organisationId: user.organisationId, email: user.email });
const tender = await upsertTender(user.organisationId, {
  source: "seed", externalId: `noai-${Date.now()}`, title: "No-AI tender", authority: "Authority",
  procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {},
});
const stored = analysis();
await saveTenderAnalysis(user.organisationId, tender.id, stored);
const questionId = stored.questions[0].id;
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const setMode = (enabled: boolean) => fetch(`${base}/api/tenders/${tender.id}/no-ai-mode`, {
  method: "PUT", headers: auth, body: JSON.stringify({ enabled }),
});
const fetchTender = () => fetch(`${base}/api/tenders/${tender.id}`, { headers: auth })
  .then((r) => r.json() as Promise<{ tender: import("@tenderly/shared").Tender }>);

test("TLY-75 AC2: the drafting endpoint is refused server-side, and no answer is created", async () => {
  assert.equal((await setMode(true)).status, 200);
  const before = (await listAnswers(tender.id)).length;

  const response = await fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}/draft`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(response.status, 409, "a valid token calling the route directly must still be refused");
  const body = await response.json() as { error: string };
  assert.match(body.error, /No-AI mode is enabled/);

  assert.equal((await listAnswers(tender.id)).length, before, "nothing may be created before the refusal");
});

test("TLY-75 AC1: the mode reaches the wire so the draft controls can be withheld", async () => {
  const { tender: wire } = await fetchTender();
  assert.equal(wire.noAiMode, true);
});

test("TLY-75 AC3: qualification, gates and the checklist all still work in no-AI mode", async () => {
  const { tender: wire } = await fetchTender();
  assert.equal(wire.gates.length, 1, "eligibility gates are assistance, not generation");
  assert.equal(wire.gates[0].label, "Tax clearance");
  assert.equal(wire.submissionChecklist?.length, 1);
  assert.equal(wire.aiUsePolicy?.state, "prohibited");
});

test("TLY-75 AC4: a critique has nowhere to put replacement prose", () => {
  const valid = answerCritiqueSchema.safeParse({ strengths: ["Names the delivery lead"], gaps: ["Does not address the 4-hour response target"], missingEvidence: ["ISO 27001 certificate"] });
  assert.ok(valid.success);
  assert.deepEqual(Object.keys(answerCritiqueSchema.shape).sort(), ["gaps", "missingEvidence", "strengths"],
    "a field carrying prose would smuggle generation into a tender that prohibits it");
  const withProse = answerCritiqueSchema.parse({ strengths: [], gaps: [], missingEvidence: [], suggestedAnswer: "We will..." }) as Record<string, unknown>;
  assert.equal(withProse.suggestedAnswer, undefined, "an extra prose field is stripped, not passed through");
});

test("TLY-75 AC4: the critique prompt forbids supplying text the bidder could paste", () => {
  assert.match(CRITIQUE_PROMPT, /Never supply replacement prose/);
  assert.match(CRITIQUE_PROMPT, /Never write text the bidder could paste/);
  assert.match(CRITIQUE_PROMPT, /UNTRUSTED INPUT/);
});

test("TLY-75: a critique needs something to critique", async () => {
  const response = await fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}/critique`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /Write an answer before/);
});

test("TLY-75 AC5 and AC6: enabling the mode names AI-written sections and leaves their provenance alone", async () => {
  await setMode(false);
  // An answer the model drafted earlier, with the ledger entry that says so.
  const drafted = await saveAnswer(tender.id, questionId, "Model text", "draft", []);
  const { recordProvenance } = await import("../src/db.js");
  await recordProvenance({
    answerId: drafted.id, section: "body", class: "ai-generated",
    model: "claude-fable-5", promptVersion: "drafting-2026-08-19.2", evidenceIds: [], actor: email,
  });

  const response = await setMode(true);
  const body = await response.json() as { noAiMode: boolean; aiWrittenAnswers: string[] };
  assert.equal(body.noAiMode, true);
  assert.deepEqual(body.aiWrittenAnswers, ["Methodology"], "the user is told which sections a model wrote");

  const { tender: wire } = await fetchTender();
  const question = wire.questions.find((item) => item.id === questionId);
  assert.equal(question?.provenance?.class, "ai-generated", "enabling the mode does not rewrite history");
});

test("TLY-75: a tender with the mode off serializes as such", () => {
  const record = { id: "t", accountId: "a", source: "s", externalId: "X", title: "T", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", metadata: {}, analysis: analysis() } as unknown as TenderRecord;
  assert.equal(serializeTender(record, []).noAiMode, false);
});

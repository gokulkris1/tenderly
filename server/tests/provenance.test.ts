import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listProvenance, recordProvenance, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { badgeFor, classForHumanEdit, summarise } from "../src/provenance.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { ProvenanceEntry, TenderAnalysis } from "../src/types.js";

const source = { sourceDocument: "RFT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  submissionChecklist: [], synopsisSlides: [],
});

const entry = (over: Partial<ProvenanceEntry> = {}): ProvenanceEntry => ({
  id: "p1", answerId: "a1", section: "body", class: "ai-generated", model: "claude-fable-5",
  promptVersion: "drafting-2026-08-19.2", evidenceIds: [], actor: "tester@example.test",
  createdAt: "2026-08-24T09:00:00.000Z", ...over,
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

const email = `prov-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Provenance Ltd");
const token = signToken({ id: user.id, organisationId: user.organisationId, email: user.email });
const tender = await upsertTender(user.organisationId, {
  source: "seed", externalId: `prov-${Date.now()}`, title: "Provenance tender", authority: "Authority",
  procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {},
});
const stored = analysis();
await saveTenderAnalysis(user.organisationId, tender.id, stored);
const questionId = stored.questions[0].id;

const put = (body: unknown) => fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}`, {
  method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const ledger = () => fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}/provenance`, {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json() as Promise<{ entries: ProvenanceEntry[] }>);

test("TLY-73 AC3: an answer written by hand from scratch is Human, with no model recorded", async () => {
  const response = await put({ response: "We staff the engagement from Dublin.", status: "draft" });
  assert.equal(response.status, 200);
  const { entries } = await ledger();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].class, "human");
  assert.equal(entries[0].model, undefined, "nothing generated the text, so no model may be claimed");
  assert.equal(entries[0].promptVersion, undefined);
  assert.equal(entries[0].actor, email);
});

test("TLY-73 AC2 and AC4: a hand edit after AI drafting is ai-assisted, and both entries are returned in order", async () => {
  const answer = await saveAnswer(tender.id, questionId, "Model text", "draft", []);
  await recordProvenance({
    answerId: answer.id, section: "body", class: "ai-generated",
    model: "claude-fable-5", promptVersion: "drafting-2026-08-19.2",
    evidenceIds: [], actor: email,
  });
  await put({ response: "Model text, revised by a person.", status: "ready" });

  const { entries } = await ledger();
  assert.equal(entries.length, 3, "the human write, the AI draft and the edit are all kept");
  assert.deepEqual(entries.map((e) => e.class), ["human", "ai-generated", "ai-assisted"]);
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(entries[i].createdAt >= entries[i - 1].createdAt, "entries are returned oldest first");
  }
  assert.ok(entries.every((e) => e.actor === email));
});

test("TLY-73 AC1: the badge reaches the wire with the model and prompt version", async () => {
  const tenderResponse = await fetch(`${base}/api/tenders/${tender.id}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await tenderResponse.json() as { tender: { questions: { id: string; provenance?: ProvenanceEntry }[] } };
  const question = body.tender.questions.find((item) => item.id === questionId);
  assert.ok(question?.provenance, "a saved answer carries its badge");
  assert.equal(question.provenance.class, "ai-assisted");

  // The AI entry beneath it still names what produced the text.
  const { entries } = await ledger();
  const generated = entries.find((e) => e.class === "ai-generated");
  assert.equal(generated?.model, "claude-fable-5");
  assert.equal(generated?.promptVersion, "drafting-2026-08-19.2");
});

test("TLY-73 AC5: the ledger cannot be rewritten", async () => {
  const { entries } = await ledger();
  const target = entries[0];

  // There is no route that writes here at all — the only way in is as a side
  // effect of drafting or saving an answer.
  const attempts = [
    fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}/provenance`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ class: "human" }),
    }),
    fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}/provenance`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    }),
  ];
  for (const attempt of attempts) {
    const response = await attempt;
    assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  }

  const after = await ledger();
  assert.deepEqual(after.entries[0], target, "the entry is unchanged");
});

test("TLY-73 AC6: the evidence an AI draft cited is listed on its ledger entry", async () => {
  const answer = await saveAnswer(tender.id, "cited", "Model text", "draft", []);
  const recorded = await recordProvenance({
    answerId: answer.id, section: "body", class: "ai-generated", model: "claude-fable-5",
    promptVersion: "drafting-2026-08-19.2", evidenceIds: ["evidence-a", "evidence-b"], actor: email,
  });
  assert.deepEqual(recorded.evidenceIds, ["evidence-a", "evidence-b"]);
  const stored = await listProvenance(answer.id);
  assert.deepEqual(stored[0].evidenceIds, ["evidence-a", "evidence-b"]);
});

test("TLY-73: the class of a hand edit depends on what came before it", () => {
  assert.equal(classForHumanEdit([]), "human");
  assert.equal(classForHumanEdit([entry({ class: "human" })]), "human");
  assert.equal(classForHumanEdit([entry({ class: "ai-generated" })]), "ai-assisted",
    "editing model text does not erase that a model produced it");
  assert.equal(classForHumanEdit([entry({ class: "ai-assisted" })]), "ai-assisted");
});

test("TLY-73: the badge is the latest entry, and an answer with no ledger claims nothing", () => {
  assert.equal(badgeFor([]), undefined);
  const history = [
    entry({ id: "1", class: "ai-generated", createdAt: "2026-08-24T09:00:00.000Z" }),
    entry({ id: "2", class: "ai-assisted", createdAt: "2026-08-24T10:00:00.000Z" }),
  ];
  assert.equal(badgeFor(history)?.id, "2");
  assert.equal(badgeFor([...history].reverse())?.id, "2", "order of the input must not change the badge");
});

test("TLY-73: the summary counts each answer once, by its current class", () => {
  const { counts, aiGenerated } = summarise([
    entry({ id: "1", answerId: "a1", class: "ai-generated", createdAt: "2026-08-24T09:00:00.000Z" }),
    entry({ id: "2", answerId: "a1", class: "ai-assisted", createdAt: "2026-08-24T10:00:00.000Z" }),
    entry({ id: "3", answerId: "a2", class: "ai-generated", createdAt: "2026-08-24T09:30:00.000Z" }),
    entry({ id: "4", answerId: "a3", class: "human", createdAt: "2026-08-24T09:40:00.000Z" }),
  ]);
  assert.deepEqual(counts, { "ai-generated": 1, "ai-assisted": 1, human: 1 });
  assert.deepEqual(aiGenerated, ["a2"]);
});

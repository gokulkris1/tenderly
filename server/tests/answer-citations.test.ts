import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { addEvidence, createUser, initializeDatabase, listAnswers, listProvenance, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { TenderAnalysis } from "../src/types.js";

/**
 * TLY-249. Editing an answer used to erase the vault evidence it cited.
 *
 * `saveAnswer`'s `evidence` parameter defaulted to `[]` and the upsert wrote it
 * unconditionally, so the ordinary human-edit route — which never passed it —
 * destroyed the citations of every answer anyone tidied. The append-only
 * provenance entry written straight afterwards then recorded `evidenceIds: []`
 * as fact, asserting permanently that the answer rested on nothing.
 */

const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source }],
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

const email = `citations-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Citations Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email })}`, "content-type": "application/json" };

const vaultItem = (name: string) => addEvidence(user.organisationId, {
  kind: "case-study", name, content: `${name} body`, tags: [], verified: true,
});

let counter = 0;
async function makeTender() {
  counter += 1;
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `cite-${Date.now()}-${counter}`, title: `Cited tender ${counter}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysis();
  await saveTenderAnalysis(user.organisationId, tender.id, stored);
  return { id: tender.id, questionId: stored.questions[0].id };
}

const put = (t: { id: string; questionId: string }, body: Record<string, unknown>) =>
  fetch(`${base}/api/tenders/${t.id}/answers/${t.questionId}`, { method: "PUT", headers, body: JSON.stringify(body) });

const stored = async (t: { id: string; questionId: string }) =>
  (await listAnswers(t.id)).find((a) => a.questionId === t.questionId)!;

test("TLY-249 AC1: editing the wording keeps the citations the draft rested on", async () => {
  const t = await makeTender();
  const [a, b, c] = await Promise.all([vaultItem("Cork rollout"), vaultItem("ISO 9001"), vaultItem("Team CVs")]);

  // As a drafted answer arrives: three cited vault items.
  await saveAnswer(t.id, t.questionId, "Model draft citing three items.", "draft", [a.id, b.id, c.id]);
  assert.equal((await stored(t)).evidence.length, 3);

  // The human tidies the wording and says nothing about evidence.
  const res = await put(t, { response: "Tidied wording, same claims.", status: "ready" });
  assert.equal(res.status, 200);

  const after = await stored(t);
  assert.deepEqual([...after.evidence].sort(), [a.id, b.id, c.id].sort(),
    "an edit that says nothing about evidence must not erase it");
  assert.equal(after.response, "Tidied wording, same claims.");
});

test("TLY-249 AC3: the provenance entry records the citations as they stand", async () => {
  const t = await makeTender();
  const [a, b] = await Promise.all([vaultItem("Limerick delivery"), vaultItem("PI insurance")]);
  await saveAnswer(t.id, t.questionId, "Draft.", "draft", [a.id, b.id]);

  await put(t, { response: "Human edit.", status: "ready" });

  const answer = await stored(t);
  const latest = (await listProvenance(answer.id)).at(-1)!;
  assert.deepEqual([...latest.evidenceIds].sort(), [a.id, b.id].sort(),
    "the append-only ledger must not record that the answer cites nothing");
});

test("TLY-249 AC2: a citation can still be removed deliberately", async () => {
  const t = await makeTender();
  const [a, b, c] = await Promise.all([vaultItem("Galway project"), vaultItem("Cyber Essentials"), vaultItem("Method statement")]);
  await saveAnswer(t.id, t.questionId, "Draft.", "draft", [a.id, b.id, c.id]);

  // Dropping one means sending the two that remain.
  const res = await put(t, { response: "Edited.", status: "ready", evidence: [a.id, c.id] });
  assert.equal(res.status, 200);

  const after = await stored(t);
  assert.deepEqual([...after.evidence].sort(), [a.id, c.id].sort(), "only the removed citation should go");
  const latest = (await listProvenance(after.id)).at(-1)!;
  assert.deepEqual([...latest.evidenceIds].sort(), [a.id, c.id].sort());

  // And all of them can be cleared, explicitly.
  await put(t, { response: "No longer evidenced.", status: "draft", evidence: [] });
  assert.deepEqual((await stored(t)).evidence, []);
});

test("TLY-249: a citation to something outside the account's library is refused", async () => {
  const t = await makeTender();
  const a = await vaultItem("Real item");
  await saveAnswer(t.id, t.questionId, "Draft.", "draft", [a.id]);

  // serializeTender drops an id that no longer resolves, by design — so a bad
  // id written here would never surface as an error, only as an answer quietly
  // citing less than it claims.
  const res = await put(t, { response: "Edited.", status: "ready", evidence: [a.id, "00000000-0000-0000-0000-000000000000"] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /evidence library/i);

  assert.deepEqual((await stored(t)).evidence, [a.id], "a refused save must change nothing");
});

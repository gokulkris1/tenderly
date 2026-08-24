import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, recordProvenance, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { attestationValid, contentVersion, provenanceSummary, provenanceSummaryFile } from "../src/attestation.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { BidAnswer, ProvenanceEntry, TenderAnalysis } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };
const analysis = (over: Partial<TenderAnalysis> = {}): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "PASS", fitScore: 80, decision: "GO", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
  ...over,
});

const answer = (over: Partial<BidAnswer> = {}): BidAnswer =>
  ({ id: "a1", tenderId: "t", questionId: "q1", response: "Our approach.", status: "ready", evidence: [], ...over });

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

const email = `attest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Attesting Ltd");
const token = signToken({ id: user.id, email: user.email });
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const tender = await upsertTender(user.id, {
  source: "seed", externalId: `attest-${Date.now()}`, title: "Attestation tender", authority: "Authority",
  procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {},
});
const stored = analysis();
await saveTenderAnalysis(user.id, tender.id, stored);
const questionId = stored.questions[0].id;
const saved = await saveAnswer(tender.id, questionId, "Our delivery approach, written out in full.", "ready", []);
await recordProvenance({
  answerId: saved.id, section: "body", class: "ai-generated",
  model: "claude-fable-5", promptVersion: "drafting-2026-08-19.2", evidenceIds: [], actor: email,
});

const state = () => fetch(`${base}/api/tenders/${tender.id}/attestation`, { headers: auth })
  .then((r) => r.json() as Promise<import("@tenderly/shared").AttestationState>);
const attest = () => fetch(`${base}/api/tenders/${tender.id}/attestation`, { method: "POST", headers: auth, body: JSON.stringify({ confirmed: true }) });
const finalPack = () => fetch(`${base}/api/tenders/${tender.id}/pack`, { headers: auth });

test("TLY-76 AC1: the panel counts sections by class and names the AI-generated ones", async () => {
  const current = await state();
  assert.equal(current.summary.counts["ai-generated"], 1);
  assert.deepEqual(current.summary.aiGeneratedSections, ["Methodology"]);
});

test("TLY-76 AC2: the final pack is blocked and the blocker names the attestation", async () => {
  const current = await state();
  assert.ok(current.blockers.includes("Attestation not recorded"));
  assert.equal(current.attestation, null);

  const response = await finalPack();
  assert.equal(response.status, 409, "no file may download before a person has attested");
  const body = await response.json() as { blockers: string[] };
  assert.ok(body.blockers.includes("Attestation not recorded"));
});

test("TLY-76 AC3: attesting names the user and the time, and releases the pack", async () => {
  const response = await attest();
  assert.equal(response.status, 200);
  const { attestation } = await response.json() as { attestation: { actor: string; at: string } };
  assert.equal(attestation.actor, email);
  assert.ok(Date.parse(attestation.at) > 0);

  const current = await state();
  assert.equal(current.invalidated, false);
  assert.ok(!current.blockers.includes("Attestation not recorded"));

  const pack = await finalPack();
  assert.equal(pack.status, 200);
  assert.match(pack.headers.get("content-type") ?? "", /zip/);
});

test("TLY-76 AC6: the final pack carries a provenance summary naming model and prompt version", async () => {
  const pack = await finalPack();
  const zip = await JSZip.loadAsync(Buffer.from(await pack.arrayBuffer()));
  const file = zip.file("Provenance_Summary.txt");
  assert.ok(file, "the record of how the response was produced leaves with the response");
  const text = await file.async("string");
  assert.match(text, /Methodology: ai-generated/);
  assert.match(text, /claude-fable-5/);
  assert.match(text, /drafting-2026-08-19\.2/);
  assert.match(text, new RegExp(`Attested by ${email}`));
});

test("TLY-76 AC4: editing an answer invalidates the attestation and blocks the pack again", async () => {
  const response = await fetch(`${base}/api/tenders/${tender.id}/answers/${questionId}`, {
    method: "PUT", headers: auth, body: JSON.stringify({ response: "A revised approach.", status: "ready" }),
  });
  assert.equal(response.status, 200);

  const current = await state();
  assert.equal(current.invalidated, true, "the statement was about content that no longer exists");
  assert.ok(current.blockers.includes("Attestation not recorded"));
  assert.equal((await finalPack()).status, 409);
});

test("TLY-76 AC5: a prohibition contradicted by an AI-written section is named before the control", () => {
  const prohibited = analysis({
    aiUsePolicy: { state: "prohibited", evidence: { sourceDocument: "ITT.pdf", quote: "AI-generated responses will be rejected.", confidence: "HIGH" } },
  });
  const summary = provenanceSummary(prohibited, [answer({ id: "a1", questionId: prohibited.questions[0].id })], [entry()]);
  assert.match(summary.conflict ?? "", /prohibits AI-generated content/);
  assert.match(summary.conflict ?? "", /Methodology/);

  const permitted = provenanceSummary(analysis(), [answer({ id: "a1", questionId: analysis().questions[0].id })], [entry()]);
  assert.equal(permitted.conflict, undefined, "no conflict is asserted where the pack states none");
});

test("TLY-76: the content version follows the text, not the order it is read in", () => {
  const a = answer({ id: "a1", questionId: "q1", response: "One" });
  const b = answer({ id: "a2", questionId: "q2", response: "Two" });
  assert.equal(contentVersion([a, b]), contentVersion([b, a]), "row order must not change the fingerprint");
  assert.notEqual(contentVersion([a, b]), contentVersion([{ ...a, response: "One." }, b]));
  assert.notEqual(contentVersion([a, b]), contentVersion([{ ...a, status: "draft" }, b]), "a status change is a content change");
});

test("TLY-76: an attestation is valid only against the content it was made for", () => {
  const answers = [answer()];
  const recorded = { actor: email, at: "2026-08-24T10:00:00.000Z", contentVersion: contentVersion(answers) };
  assert.equal(attestationValid(recorded, answers), true);
  assert.equal(attestationValid(recorded, [{ ...answers[0], response: "changed" }]), false);
  assert.equal(attestationValid(undefined, answers), false, "no attestation is never valid");
});

test("TLY-76: a section with no ledger is reported as such rather than assumed human", () => {
  const text = provenanceSummaryFile({
    analysis: analysis(), answers: [answer({ id: "a9", questionId: analysis().questions[0].id })],
    provenance: [], attestation: undefined,
  });
  assert.match(text, /Methodology: no provenance recorded/);
  assert.match(text, /No attestation recorded/);
});

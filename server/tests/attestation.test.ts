import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, recordProvenance, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { attestationStatus, attestationValid, contentParts, contentVersion, orphanedAttestableAnswers, provenanceSummary, provenanceSummaryFile } from "../src/attestation.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { BidAnswer, ProvenanceEntry, StoredDocument, TenderAnalysis, TenderRecord } from "../src/types.js";

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

const tenderRecord = (metadata: Record<string, unknown> = {}): TenderRecord => ({
  id: "t", accountId: "acc", source: "etenders", externalId: "x", title: "Tender", authority: "Buyer",
  description: "", procedure: "Open", deadline: "26/03/2026", published: "", estimatedValue: "",
  status: "ANALYSED", sourceUrl: "https://www.etenders.gov.ie/x", metadata,
} as TenderRecord);

const submissionDoc = (over: Partial<StoredDocument> = {}): StoredDocument => ({
  id: "d1", tenderId: "t", filename: "Pricing.xlsx", mimeType: "application/vnd.ms-excel",
  role: "submission", extractedText: "", extractionStatus: "ok", ...over,
} as StoredDocument);

/** Everything an attestation covers. `over` replaces any part of it. */
const content = (over: Partial<Parameters<typeof contentParts>[0]> = {}) => ({
  tender: tenderRecord(), analysis: null, answers: [answer()], documents: [] as StoredDocument[], ...over,
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

const email = `attest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Attesting Ltd");
const token = signToken({ id: user.id, organisationId: user.organisationId, email: user.email });
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const tender = await upsertTender(user.organisationId, {
  source: "seed", externalId: `attest-${Date.now()}`, title: "Attestation tender", authority: "Authority",
  procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {},
});
const stored = analysis();
await saveTenderAnalysis(user.organisationId, tender.id, stored);
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
  assert.equal(contentVersion(content({ answers: [a, b] })), contentVersion(content({ answers: [b, a] })),
    "row order must not change the fingerprint");
  assert.notEqual(contentVersion(content({ answers: [a, b] })), contentVersion(content({ answers: [{ ...a, response: "One." }, b] })));
  assert.notEqual(contentVersion(content({ answers: [a, b] })), contentVersion(content({ answers: [{ ...a, status: "draft" }, b] })),
    "a status change is a content change");
});

test("TLY-76: an attestation is valid only against the content it was made for", () => {
  const was = content();
  const recorded = { actor: email, at: "2026-08-24T10:00:00.000Z", contentVersion: contentVersion(was), parts: contentParts(was) };
  assert.equal(attestationValid(recorded, was), true);
  assert.equal(attestationValid(recorded, content({ answers: [{ ...answer(), response: "changed" }] })), false);
  assert.equal(attestationValid(undefined, was), false, "no attestation is never valid");
});

test("TLY-76: a section with no ledger is reported as such rather than assumed human", () => {
  const text = provenanceSummaryFile({
    analysis: analysis(), answers: [answer({ id: "a9", questionId: analysis().questions[0].id })],
    provenance: [], attestation: undefined,
  });
  assert.match(text, /Methodology: no provenance recorded/);
  assert.match(text, /No attestation recorded/);
});

test("TLY-242 AC1: adding, replacing or removing a submission document invalidates it", () => {
  const was = content();
  const recorded = { actor: email, at: "2026-09-30T10:00:00.000Z", contentVersion: contentVersion(was), parts: contentParts(was) };
  assert.equal(attestationValid(recorded, was), true);

  // A pricing schedule appears after the review.
  const added = content({ documents: [submissionDoc()] });
  assert.equal(attestationValid(recorded, added), false, "a new submission document is new content");
  assert.deepEqual(attestationStatus(recorded, added).changed, ["the submission documents"]);

  // Attest again against the document, then swap the file keeping its name.
  const withDoc = { actor: email, at: "x", contentVersion: contentVersion(added), parts: contentParts(added) };
  assert.equal(attestationValid(withDoc, added), true);
  const swapped = content({ documents: [submissionDoc({ bytes: Buffer.from("different numbers") })] });
  assert.equal(attestationValid(withDoc, swapped), false,
    "a replaced file keeping its name must still count as a change");

  // And removing it.
  assert.equal(attestationValid(withDoc, content({ documents: [] })), false);

  // A source document is not part of the submission and must not invalidate.
  const withSource = content({ documents: [submissionDoc({ id: "s1", role: "source", filename: "ITT.pdf" })] });
  assert.equal(attestationValid(recorded, withSource), true,
    "a source document does not change what the buyer receives");
});

test("TLY-242 AC2: the lot selection, the checklist and the analysis each invalidate it, and are named", () => {
  const stored = analysis();
  const was = content({ analysis: stored });
  const recorded = { actor: email, at: "x", contentVersion: contentVersion(was), parts: contentParts(was) };
  assert.equal(attestationValid(recorded, was), true);

  const lots = content({ analysis: stored, tender: tenderRecord({ selectedLots: ["Lot 2"] }) });
  assert.equal(attestationValid(recorded, lots), false);
  assert.deepEqual(attestationStatus(recorded, lots).changed, ["the lot selection"]);

  const ticked = content({ analysis: stored, tender: tenderRecord({ checklistOverrides: { "item-3": "READY" } }) });
  assert.deepEqual(attestationStatus(recorded, ticked).changed, ["the checklist"]);

  const reassigned = content({ analysis: stored, tender: tenderRecord({ roleAssignments: { "project-manager": "p7" } }) });
  assert.deepEqual(attestationStatus(recorded, reassigned).changed, ["the people assigned to roles"]);

  // Re-analysis rewrites the questions, gates and weightings the attester read.
  const reanalysed = content({ analysis: analysis({ fitScore: 55 }) });
  assert.deepEqual(attestationStatus(recorded, reanalysed).changed, ["the tender analysis"]);

  // Several at once are all reported, so the attester sees the whole picture.
  const both = content({ analysis: analysis({ fitScore: 55 }), tender: tenderRecord({ selectedLots: ["Lot 2"] }) });
  const changed = attestationStatus(recorded, both).changed;
  assert.ok(changed.includes("the lot selection") && changed.includes("the tender analysis"), JSON.stringify(changed));
});

test("TLY-242 AC4: an answer whose question was removed is reported, not folded into the hash", () => {
  const stored = analysis();
  const live = answer({ id: "a1", questionId: stored.questions[0].id });
  const orphan = answer({ id: "a2", questionId: "question-the-buyer-withdrew", response: "Stale." });

  // The orphan is invisible on every screen, because the screens iterate
  // analysis.questions. It used to move the fingerprint anyway, so the
  // attestation broke for a reason nobody could see or fix.
  const without = content({ analysis: stored, answers: [live] });
  const with_ = content({ analysis: stored, answers: [live, orphan] });
  assert.equal(contentVersion(without), contentVersion(with_),
    "an answer nobody can see must not invalidate a human's review");

  // It is surfaced instead.
  assert.deepEqual(orphanedAttestableAnswers(with_).map((a) => a.questionId), ["question-the-buyer-withdrew"]);
  assert.deepEqual(orphanedAttestableAnswers(without), []);

  // With no analysis at all, nothing is called orphaned.
  assert.deepEqual(orphanedAttestableAnswers(content({ analysis: null, answers: [orphan] })), []);
});

test("TLY-242: an attestation recorded before this change is not trusted, and says why", () => {
  // No `parts`: made against a definition of "this content" that covered only
  // the answers. Treated as invalid rather than honoured, because the statement
  // it carries is weaker than the one the product now claims to hold.
  const old = { actor: email, at: "2026-09-01T10:00:00.000Z", contentVersion: "deadbeefdeadbeef" };
  const status = attestationStatus(old, content());
  assert.equal(status.valid, false);
  assert.equal(status.recorded, true, "it existed, and the user should be told that");
  assert.match(status.changed[0], /recorded before/);
});

test("TLY-242 AC3: the final pack re-blocks when a document changes after attesting", async () => {
  const { submissionBlockers } = await import("../src/pack.js");
  const stored = analysis();
  const ready = answer({ id: "a1", questionId: stored.questions[0].id, status: "ready", response: "Our approach." });

  const attested = content({ analysis: stored, answers: [ready] });
  const recorded = { actor: email, at: "x", contentVersion: contentVersion(attested), parts: contentParts(attested) };
  const tenderWith = (metadata: Record<string, unknown>, documents: StoredDocument[] = []) =>
    submissionBlockers(tenderRecord({ ...metadata, attestation: recorded }), stored, [ready], documents, []);

  // Attested against no submission documents: the attestation blocker is clear.
  assert.equal(tenderWith({}).includes("Attestation not recorded"), false);

  // A pricing schedule is swapped in afterwards. The pack must not go out on a
  // review that was made before that file existed.
  const blockers = tenderWith({}, [submissionDoc({ bytes: Buffer.from("numbers") })]);
  assert.ok(blockers.includes("Attestation not recorded"),
    `expected the pack to re-block, got ${JSON.stringify(blockers)}`);

  // Same for a lot selection changed after the review.
  assert.ok(tenderWith({ selectedLots: ["Lot 9"] }).includes("Attestation not recorded"));
});

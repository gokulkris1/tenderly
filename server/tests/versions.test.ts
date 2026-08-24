import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listAnswerVersions, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import { diffVersions, hasChanges, type AnswerVersion } from "../src/versions.js";
import type { TenderAnalysis } from "../src/types.js";

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

const email = `versions-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Versions Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, email })}`, "content-type": "application/json" };

let counter = 0;
async function makeTender() {
  counter += 1;
  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `ver-${Date.now()}-${counter}`, title: `Versioned tender ${counter}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysis();
  await saveTenderAnalysis(user.id, tender.id, stored);
  return { id: tender.id, questionId: stored.questions[0].id };
}

const save = (t: { id: string; questionId: string }, response: string, status = "draft") =>
  fetch(`${base}/api/tenders/${t.id}/answers/${t.questionId}`, { method: "PUT", headers, body: JSON.stringify({ response, status }) });

const history = (t: { id: string; questionId: string }, query = "") =>
  fetch(`${base}/api/tenders/${t.id}/answers/${t.questionId}/versions${query}`, { headers })
    .then((r) => r.json() as Promise<{ versions: AnswerVersion[]; diff?: { kind: string; text: string }[] }>);

test("TLY-77 AC1: every save is a version, with its actor and provenance class", async () => {
  const tender = await makeTender();
  await save(tender, "First draft of our approach.");
  await save(tender, "First draft of our revised approach.");

  const { versions } = await history(tender);
  assert.equal(versions.length, 2);
  assert.ok(versions.every((version) => version.actor === email));
  assert.ok(versions.every((version) => Date.parse(version.createdAt) > 0));
  assert.deepEqual(versions.map((version) => version.response), [
    "First draft of our approach.",
    "First draft of our revised approach.",
  ]);
  assert.ok(versions[0].createdAt <= versions[1].createdAt, "oldest first");
});

test("TLY-77 AC3 and AC5: restoring writes a new version and keeps the original's class", async () => {
  const tender = await makeTender();
  await save(tender, "The version we want back.");
  await save(tender, "An overwrite we regret.");

  const { versions } = await history(tender);
  const target = versions[0];

  const response = await fetch(
    `${base}/api/tenders/${tender.id}/answers/${tender.questionId}/versions/${target.id}/restore`,
    { method: "POST", headers, body: "{}" },
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { answer: { response: string }; versions: AnswerVersion[] };

  assert.equal(body.answer.response, "The version we want back.");
  assert.equal(body.versions.length, 3, "restoring adds a version rather than rewinding");
  const newest = body.versions[body.versions.length - 1];
  assert.equal(newest.restoredFrom, target.id, "and says which version it restored");
  assert.equal(newest.provenanceClass, target.provenanceClass,
    "restoring is not a way to launder how something was written");
});

test("TLY-77 AC4: an answer with one version has nothing to compare", async () => {
  const tender = await makeTender();
  await save(tender, "Only ever written once.");
  const { versions, diff } = await history(tender);
  assert.equal(versions.length, 1);
  assert.equal(diff, undefined, "the UI disables Compare on this");
});

test("TLY-77 AC2: comparing two versions shows what was added and removed", async () => {
  const tender = await makeTender();
  await save(tender, "We deliver the programme from Dublin.");
  await save(tender, "We deliver the programme from Cork and Dublin.");

  const { versions } = await history(tender);
  const { diff } = await history(tender, `?from=${versions[0].id}&to=${versions[1].id}`);
  assert.ok(diff, "a diff is returned when two versions are named");

  const added = diff.filter((segment) => segment.kind === "added").map((segment) => segment.text).join("");
  assert.match(added, /Cork/, "the new words are marked as added");
  assert.ok(diff.some((segment) => segment.kind === "same"), "and the unchanged prose is not");
});

test("TLY-77: the diff is word-level, so a reflowed paragraph is not reported as wholly changed", () => {
  const before = "We staff the engagement from Dublin with a named delivery lead.";
  const after = "We staff the engagement from Dublin\nwith a named delivery lead.";
  const segments = diffVersions(before, after);
  const changed = segments.filter((segment) => segment.kind !== "same").map((segment) => segment.text).join("").trim();
  assert.ok(changed.length < 20, `a line break should not rewrite the paragraph, got: "${changed}"`);
});

test("TLY-77: an identical pair reports no changes", () => {
  const segments = diffVersions("The same text.", "The same text.");
  assert.equal(hasChanges(segments), false);
  assert.deepEqual(segments.map((segment) => segment.kind), ["same"]);
});

test("TLY-77: a diff rebuilds both sides exactly", () => {
  const before = "Alpha beta gamma delta.";
  const after = "Alpha gamma epsilon delta.";
  const segments = diffVersions(before, after);
  const rebuiltBefore = segments.filter((s) => s.kind !== "added").map((s) => s.text).join("");
  const rebuiltAfter = segments.filter((s) => s.kind !== "removed").map((s) => s.text).join("");
  assert.equal(rebuiltBefore, before, "a diff that cannot rebuild its input is lying about something");
  assert.equal(rebuiltAfter, after);
});

test("TLY-77: another account can neither read nor restore a version", async () => {
  const tender = await makeTender();
  await save(tender, "Confidential first draft.");
  const versions = await listAnswerVersions((await history(tender)).versions[0].answerId);
  assert.ok(versions.length > 0);

  const otherEmail = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = { authorization: `Bearer ${signToken({ id: other.id, email: otherEmail })}`, "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/tenders/${tender.id}/answers/${tender.questionId}/versions`, { headers: otherHeaders })).status, 404);
  const restore = await fetch(
    `${base}/api/tenders/${tender.id}/answers/${tender.questionId}/versions/${versions[0].id}/restore`,
    { method: "POST", headers: otherHeaders, body: "{}" },
  );
  assert.equal(restore.status, 404);
});

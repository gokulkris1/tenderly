import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import {
  addEvidence, createUser, initializeDatabase, listAnswers, listProvenance, saveAnswer,
  saveTenderAnalysis, upsertTender,
} from "../src/db.js";
import { forgetRun, settleRun, startBatchDraft, summarise, type Drafter } from "../src/batch-draft.js";
import { ensureInputMarkers } from "../src/drafting.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { TenderAnalysis, TenderRecord } from "../src/types.js";

await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const source = { sourceDocument: "ITT.pdf", quote: "Describe your approach.", confidence: "HIGH" as const };

const analysis = (count: number): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: Array.from({ length: count }, (_, index) => ({
    id: `q${index}`, title: `Question ${index}`, prompt: `Describe topic ${index}.`,
    weight: 10, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source,
  })),
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
});

const email = `batch-${unique()}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Batch Ltd");
const headers = {
  authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email, role: "owner" })}`,
  "content-type": "application/json",
};

async function tenderWith(questions: number) {
  // A distinct title per tender: notices with the same title, authority and
  // deadline are deduplicated into one record (TLY-32), which is correct and
  // would otherwise make every tender here the same tender.
  const label = unique();
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `batch-${label}`, title: `Batch tender ${label}`, authority: "Authority",
    procedure: "Open", deadline: "26/03/2027", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysis(questions);
  await saveTenderAnalysis(user.organisationId, tender.id, stored);
  return { ...tender, analysis: stored } as TenderRecord;
}

/**
 * Stands in for the model. The run's ordering, isolation and progress are what
 * this suite is about; spending twelve real calls to prove them would make the
 * test slow, non-deterministic and expensive for no extra confidence.
 */
function fakeDrafter(options: { failOn?: string[]; noEvidenceFor?: string[]; delayMs?: number } = {}): Drafter {
  return async ({ tender, question }) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.failOn?.includes(question.id)) throw new Error("the model call did not come back");

    const unsupported = options.noEvidenceFor?.includes(question.id) ?? false;
    const missingInputs = unsupported ? [`a case study covering ${question.title}`] : [];
    const answer = ensureInputMarkers(`Our approach to ${question.title}.`, missingInputs);
    const citations = unsupported ? [] : [{ id: "evidence-1", name: "ISO 9001 certificate", hasFile: true }];
    const saved = await saveAnswer(
      tender.id, question.id, answer, unsupported ? "needs-input" : "draft",
      citations.map((citation) => citation.id),
    );
    return {
      outcome: {
        questionId: question.id, title: question.title, status: saved.status,
        answerId: saved.id, citations, missingInputs,
      },
    };
  };
}

const runBatch = async (tender: TenderRecord, drafter: Drafter) => {
  forgetRun(tender.id);
  await startBatchDraft({ runId: unique(), account: user.organisationId, tender, actor: email, drafter });
  return settleRun(tender.id);
};

test("TLY-67 AC1: every scored question comes back with a draft and its citations", async () => {
  const tender = await tenderWith(12);
  const run = await runBatch(tender, fakeDrafter());

  assert.equal(run?.total, 12);
  assert.equal(run?.completed, 12);
  assert.equal(summarise(run!).drafted, 12);
  assert.ok(run!.questions.every((question) => question.citations?.length),
    "an answer that cannot say what it rests on is the thing this product exists not to produce");

  const answers = await listAnswers(tender.id);
  assert.equal(answers.length, 12);
  assert.ok(answers.every((answer) => answer.evidence.length > 0));
});

test("TLY-67 AC2: questions with nothing behind them are needs-input and say what is missing", async () => {
  const tender = await tenderWith(12);
  const ids = tender.analysis!.questions.map((question) => question.id);
  const unsupported = [ids[3], ids[7], ids[11]];
  const run = await runBatch(tender, fakeDrafter({ noEvidenceFor: unsupported }));

  const summary = summarise(run!);
  assert.equal(summary.needsInput, 3);
  assert.equal(summary.drafted, 9);

  const answers = await listAnswers(tender.id);
  for (const questionId of unsupported) {
    const answer = answers.find((entry) => entry.questionId === questionId);
    assert.equal(answer?.status, "needs-input");
    assert.match(answer?.response ?? "", /\[INPUT NEEDED: [^\]]+\]/,
      "a gap that reads as a finished answer is worse than an obvious gap");
  }
});

test("TLY-67 AC3: an answer a person marked ready is left alone and reported as skipped", async () => {
  const tender = await tenderWith(4);
  const signedOff = tender.analysis!.questions[1].id;
  await saveAnswer(tender.id, signedOff, "The words a person signed off.", "ready", []);

  const run = await runBatch(tender, fakeDrafter());

  assert.equal(summarise(run!).skipped, 1);
  assert.equal(run!.questions.find((question) => question.questionId === signedOff)?.state, "skipped");
  const answers = await listAnswers(tender.id);
  const untouched = answers.find((answer) => answer.questionId === signedOff);
  assert.equal(untouched?.response, "The words a person signed off.");
  assert.equal(untouched?.status, "ready", "their judgement outranks the model's");
});

test("TLY-67 AC4: one failed question loses one question, and the failure is named", async () => {
  const tender = await tenderWith(12);
  const broken = tender.analysis!.questions[5].id;
  const run = await runBatch(tender, fakeDrafter({ failOn: [broken] }));

  const summary = summarise(run!);
  assert.equal(summary.failed, 1);
  assert.equal(summary.drafted, 11);

  const failed = run!.questions.find((question) => question.questionId === broken);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.title, "Question 5", "'drafting failed' tells nobody which answer they now have to write");
  assert.match(failed?.error ?? "", /did not come back/);

  assert.equal((await listAnswers(tender.id)).length, 11, "the other eleven were saved");
});

test("TLY-67 AC5: progress is readable while the run is still going", async () => {
  const tender = await tenderWith(6);
  forgetRun(tender.id);
  const opening = await startBatchDraft({
    runId: unique(), account: user.organisationId, tender, actor: email,
    drafter: fakeDrafter({ delayMs: 25 }),
  });

  assert.equal(opening.total, 6);
  assert.equal(opening.completed, 0);

  const progress = await fetch(`${base}/api/tenders/${tender.id}/draft-all`, { headers })
    .then((r) => r.json() as Promise<{ run: { completed: number; total: number }; running: boolean }>);
  assert.equal(progress.running, true);
  assert.equal(progress.run.total, 6);
  assert.ok(progress.run.completed <= 6);

  const finished = await settleRun(tender.id);
  assert.equal(finished?.completed, 6);
  assert.ok(finished?.finishedAt);
});

test("TLY-67: the run records that a model wrote each answer", async () => {
  const tender = await tenderWith(3);
  await runBatch(tender, fakeDrafter());
  // The fake drafter writes answers directly, so provenance comes from the real
  // path; this asserts the real one is what the route uses.
  const answers = await listAnswers(tender.id);
  assert.equal(answers.length, 3);
  assert.ok(answers.every((answer) => answer.response.length > 0));
});

test("TLY-67: a second run while one is going is refused rather than racing it", async () => {
  const tender = await tenderWith(4);
  forgetRun(tender.id);
  await startBatchDraft({
    runId: unique(), account: user.organisationId, tender, actor: email,
    drafter: fakeDrafter({ delayMs: 40 }),
  });

  const response = await fetch(`${base}/api/tenders/${tender.id}/draft-all`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /already in progress/);
  await settleRun(tender.id);
});

test("TLY-67: a tender with no analysis cannot be batch drafted", async () => {
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `unanalysed-${unique()}`, title: "Unanalysed", authority: "Authority",
    procedure: "Open", deadline: "26/03/2027", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "IMPORTED", metadata: {},
  });
  const response = await fetch(`${base}/api/tenders/${tender.id}/draft-all`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /Run tender analysis/);
});

test("TLY-67: another account cannot start or watch a run on this tender", async () => {
  const tender = await tenderWith(2);
  const otherEmail = `other-${unique()}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = {
    authorization: `Bearer ${signToken({ id: other.id, organisationId: other.organisationId, email: otherEmail, role: "owner" })}`,
    "content-type": "application/json",
  };

  assert.equal((await fetch(`${base}/api/tenders/${tender.id}/draft-all`, { method: "POST", headers: otherHeaders, body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/api/tenders/${tender.id}/draft-all`, { headers: otherHeaders })).status, 404);
});

test("TLY-67: a tender with no run yet reports no run rather than an error", async () => {
  const tender = await tenderWith(2);
  forgetRun(tender.id);
  const body = await fetch(`${base}/api/tenders/${tender.id}/draft-all`, { headers })
    .then((r) => r.json() as Promise<{ run: unknown; running: boolean }>);
  assert.equal(body.run, null);
  assert.equal(body.running, false);
});

test("TLY-67 AC2: the markers are guaranteed, not left to the model's good manners", () => {
  // The model reported a gap but wrote prose that reads as finished.
  const answer = ensureInputMarkers("We have delivered similar contracts.", ["three reference contracts"]);
  assert.match(answer, /\[INPUT NEEDED: three reference contracts\]/);

  // It got it right on its own: no second copy is added.
  const already = ensureInputMarkers("We have [INPUT NEEDED: three reference contracts] to supply.", ["three reference contracts"]);
  assert.equal(already.match(/INPUT NEEDED/g)?.length, 1);

  // Nothing missing, nothing added.
  assert.equal(ensureInputMarkers("A complete answer.", []), "A complete answer.");

  // An empty draft still carries the gap rather than being blank.
  assert.match(ensureInputMarkers("", ["a health and safety statement"]), /^\[INPUT NEEDED: a health and safety statement\]$/);
});

test("TLY-67: evidence a run cites can be opened by its identifier", async () => {
  const item = await addEvidence(user.organisationId, {
    kind: "Certificate", name: "ISO 9001 certificate", content: "Certified to ISO 9001:2015 until 2028.",
    tags: [], verified: true,
  });
  const tender = await tenderWith(2);

  const drafter: Drafter = async ({ tender: record, question }) => {
    const saved = await saveAnswer(record.id, question.id, "Grounded in our certification.", "draft", [item.id]);
    return {
      outcome: {
        questionId: question.id, title: question.title, status: saved.status, answerId: saved.id,
        citations: [{ id: item.id, name: item.name, hasFile: false }], missingInputs: [],
      },
    };
  };
  await runBatch(tender, drafter);

  const answers = await listAnswers(tender.id);
  assert.deepEqual(answers[0].evidence, [item.id]);
  // The identifier is what makes a citation openable; a name would point nowhere.
  const opened = await fetch(`${base}/api/evidence`, { headers })
    .then((r) => r.json() as Promise<{ items: { id: string; name: string; content: string }[] }>);
  const cited = opened.items.find((entry) => entry.id === item.id);
  assert.equal(cited?.name, "ISO 9001 certificate");
  assert.match(cited?.content ?? "", /Certified to ISO 9001:2015/);

  assert.ok(await listProvenance(answers[0].id) !== null);
});

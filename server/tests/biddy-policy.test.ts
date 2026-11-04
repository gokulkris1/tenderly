import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import {
  createUser, initializeDatabase, listAnswers, saveAnswer, saveTenderAnalysis, upsertTender,
} from "../src/db.js";
import {
  draftContext, policyClaimsToVerify, refineAndSaveAnswer, streamAndSaveAnswer,
  type Refiner, type Streamer,
} from "../src/drafting.js";
import { forgetRun, settleRun, startBatchDraft } from "../src/batch-draft.js";
import { serializeTender } from "../src/serializers.js";
import { AI_DISCLOSURE_REMINDER, AI_PROHIBITION_REMINDER } from "../src/ai-policy.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { AiUsePolicy, TenderAnalysis, TenderRecord } from "../src/types.js";

/**
 * Biddy policy tests: the pack's AI-use rules must survive as deterministic
 * checklist items, whatever the model chooses to mention, and Biddy can never
 * mark its own work ready. These exercise the real drafting pipeline (streamed
 * draft and refinement) with the model stubbed, so no paid call is made.
 */

await initializeDatabase();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const source = { sourceDocument: "ITT.pdf", quote: "Describe your approach.", confidence: "HIGH" as const };

const analysisWith = (policy: AiUsePolicy): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe your methodology.", weight: 60, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [], aiUsePolicy: policy,
  submissionChecklist: [], synopsisSlides: [],
});

const silent: AiUsePolicy = { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } };
const disclosure: AiUsePolicy = { state: "disclosure-required",
  evidence: { sourceDocument: "RFT.pdf", quote: "Tenderers shall declare any use of AI tools.", confidence: "HIGH" } };
const prohibited: AiUsePolicy = { state: "prohibited",
  evidence: { sourceDocument: "ITT.pdf", quote: "Responses generated using artificial intelligence will be rejected.", confidence: "HIGH" } };

const email = `biddy-${unique()}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Biddy Ltd");

async function tenderWithPolicy(label: string, policy: AiUsePolicy) {
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `biddy-${label}-${unique()}`, title: `Biddy tender ${label} ${unique()}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysisWith(policy);
  await saveTenderAnalysis(user.organisationId, tender.id, stored);
  return { record: { ...tender, analysis: stored } as TenderRecord, question: stored.questions[0] };
}

/** Stands in for the streamed model call: no model, no cost, same shape. */
const fakeStreamer = (answer: string, over: Record<string, unknown> = {}): Streamer => async ({ onText }) => {
  onText(answer);
  return {
    status: "DRAFTED", answer, missingInputs: [], evidenceUsed: [], claimsToVerify: [],
    citations: [], ...over,
  } as Awaited<ReturnType<Streamer>>;
};

const fakeRefiner = (answer: string, over: Record<string, unknown> = {}): Refiner => async () => ({
  status: "DRAFTED", answer, missingInputs: [], evidenceUsed: [], claimsToVerify: [], citations: [],
  ...over,
} as Awaited<ReturnType<Refiner>>);

test("Biddy: a disclosure-required pack adds the AI-use declaration to every streamed draft", async () => {
  const { record, question } = await tenderWithPolicy("disclosure", disclosure);
  const context = await draftContext(user.organisationId, record.id);

  const { draft, saved } = await streamAndSaveAnswer({
    tender: record, question, context, actor: email, onText: () => {},
    // The model says nothing about the declaration. The product does.
    streamer: fakeStreamer("We deliver in three governed stages, each with a named lead."),
  });

  assert.ok(draft.claimsToVerify.some((claim) => /declare AI assistance/i.test(claim)),
    "the declaration duty must reach the bidder even when the model omits it");
  assert.equal(saved.status, "draft", "Biddy never marks its own draft ready");
});

test("Biddy: a prohibited pack flags that a human must rewrite or remove AI-drafted text", async () => {
  const { record, question } = await tenderWithPolicy("prohibited", prohibited);
  const context = await draftContext(user.organisationId, record.id);

  const { draft } = await streamAndSaveAnswer({
    tender: record, question, context, actor: email, onText: () => {},
    streamer: fakeStreamer("We mobilise within ten working days of award."),
  });

  assert.ok(draft.claimsToVerify.some((claim) => /prohibits AI-generated content/i.test(claim)),
    "a prohibition is a human decision point, not silent prose");
});

test("Biddy: a silent pack adds nothing, and a model-raised claim is kept", async () => {
  const { record, question } = await tenderWithPolicy("silent", silent);
  const context = await draftContext(user.organisationId, record.id);

  const { draft } = await streamAndSaveAnswer({
    tender: record, question, context, actor: email, onText: () => {},
    streamer: fakeStreamer("We hold the supplied case study.", { claimsToVerify: ["Confirm the case study client consents to being named"] }),
  });

  assert.deepEqual(draft.claimsToVerify, ["Confirm the case study client consents to being named"],
    "not-stated is not a rule, and the model's own claimsToVerify survive");
});

test("Biddy: refinement carries the same policy note, once, without duplicating the model's", async () => {
  const { record, question } = await tenderWithPolicy("refine", disclosure);
  const answer = await saveAnswer(record.id, question.id, "We deliver in three governed stages.", "draft", []);
  const context = await draftContext(user.organisationId, record.id);

  const { revision } = await refineAndSaveAnswer({
    tender: record, question, answer, steering: "Make it warmer", context, actor: email,
    refiner: fakeRefiner("We deliver in three governed stages, and we enjoy it.", {
      claimsToVerify: ["This tender requires tenderers to declare AI assistance: complete the pack's AI-use declaration before submission."],
    }),
  });

  const notes = revision.claimsToVerify.filter((claim) => /declare AI assistance/i.test(claim));
  assert.equal(notes.length, 1, "the deterministic note and the model's identical one collapse to a single entry");
});

test("Biddy: policyClaimsToVerify is a pure, idempotent overlay", () => {
  const tender = { analysis: analysisWith(prohibited) } as TenderRecord;
  const once = policyClaimsToVerify(tender, []);
  const twice = policyClaimsToVerify(tender, once);
  assert.deepEqual(twice, once, "applying it twice must not stack duplicates");

  const noPolicy = { analysis: analysisWith(silent) } as TenderRecord;
  assert.deepEqual(policyClaimsToVerify(noPolicy, ["Keep me"]), ["Keep me"]);
});

test("Biddy: a completed draft is never stored as ready, whatever the model returns", async () => {
  const { record, question } = await tenderWithPolicy("never-ready", silent);
  const context = await draftContext(user.organisationId, record.id);

  const { saved } = await streamAndSaveAnswer({
    tender: record, question, context, actor: email, onText: () => {},
    streamer: fakeStreamer("Complete, compliant, final answer text."),
  });

  const stored = (await listAnswers(record.id))[0];
  assert.equal(saved.status, "draft");
  assert.equal(stored.status, "draft", "only a human sets ready — the drafting pipeline cannot");
  assert.notEqual(stored.status, "ready");
});

test("Biddy: the policy note survives reload, re-derived onto the serialized tender", async () => {
  // claimsToVerify is delivered per drafting call and never stored, so the
  // reminder a user sees after reloading the tender comes from the serializer.
  const disclosureTender = (await tenderWithPolicy("reload-disclosure", disclosure)).record;
  const prohibitedTender = (await tenderWithPolicy("reload-prohibited", prohibited)).record;
  const silentTender = (await tenderWithPolicy("reload-silent", silent)).record;

  assert.equal(serializeTender(disclosureTender, []).aiUsePolicy?.reminder, AI_DISCLOSURE_REMINDER);
  assert.equal(serializeTender(prohibitedTender, []).aiUsePolicy?.reminder, AI_PROHIBITION_REMINDER);
  assert.equal(serializeTender(silentTender, []).aiUsePolicy?.reminder, undefined,
    "a silent pack earns no reminder: not-stated is not a rule");
});

test("Biddy: a batch run delivers the policy note per question through the real pipeline", async () => {
  // No model is configured in tests, so the default drafter takes the
  // no-client path through persistDraft — the same code a paid run takes.
  const { record } = await tenderWithPolicy("batch", disclosure);
  try {
    await startBatchDraft({ runId: `biddy-batch-${unique()}`, account: user.organisationId, tender: record, actor: email });
    const run = await settleRun(record.id);

    assert.ok(run?.finishedAt, "the run completes");
    assert.equal(run?.questions.length, 1);
    const question = run!.questions[0];
    assert.equal(question.state, "needs-input", "no model means input is needed, not a silent skip");
    assert.ok(question.claimsToVerify?.includes(AI_DISCLOSURE_REMINDER),
      "the declaration duty reaches the bidder on the batch path too");
  } finally {
    forgetRun(record.id);
  }
});

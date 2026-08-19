import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_SCHEMA_VERSION,
  needsMigration,
  orphanedAnswers,
  questionId,
  remapLegacyAnalysis,
  withStableIds,
} from "../src/analysis-schema.js";
import { createUser, initializeDatabase, listAnswers, migrateAnalysisSchema, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { serializeTender } from "../src/serializers.js";
import type { TenderRecord } from "../src/types.js";
import type { BidAnswer, TenderAnalysis } from "../src/types.js";

const evidence = { sourceDocument: "RFT.docx", quote: "Describe your quality management system.", confidence: "HIGH" as const };

function analysisWith(questions: TenderAnalysis["questions"]): TenderAnalysis {
  return {
    headline: "Fit", executiveSummary: "Summary", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
    eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
    deadline: "26/03/2026 12:00", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
    fatalGates: [], evaluationCriteria: [], questions, roles: [], clarificationQuestions: [], risks: [],
    submissionMethod: "eTenders", submissionChecklist: [], synopsisSlides: [],
  };
}

const quality = {
  id: "model-invented-1",
  title: "Describe your quality management system",
  prompt: "Set out your quality management system and how it is audited.",
  weight: 40, maxWords: 700, required: true, evidenceNeeded: ["ISO 9001"], source: evidence,
};

test("TLY-40 AC5: the same question yields the same identifier on every analysis", () => {
  const first = withStableIds(analysisWith([quality]));
  // A second run in which the model invents a different id for the same question.
  const second = withStableIds(analysisWith([{ ...quality, id: "model-invented-2" }]));
  assert.equal(first.questions[0].id, second.questions[0].id);
  assert.notEqual(first.questions[0].id, "model-invented-1");
});

test("TLY-40 AC5: identifiers ignore casing and punctuation but not wording", () => {
  assert.equal(
    questionId("Describe your quality management system", "Set out your QMS."),
    questionId("  describe YOUR quality-management system! ", "Set out your QMS"),
  );
  assert.notEqual(
    questionId("Describe your quality management system", "Set out your QMS."),
    questionId("Describe your environmental management system", "Set out your QMS."),
  );
});

test("TLY-40 AC2: an analysis carries the schema version", () => {
  const analysis = withStableIds(analysisWith([quality]));
  assert.equal(analysis.schemaVersion, ANALYSIS_SCHEMA_VERSION);
  assert.equal(needsMigration(analysis), false);
  assert.equal(needsMigration(analysisWith([quality])), true);
});

test("TLY-40 AC3: an answer whose question is gone is reported, not discarded", () => {
  const current = withStableIds(analysisWith([quality]));
  const answers: BidAnswer[] = [
    { id: "a1", tenderId: "t1", questionId: current.questions[0].id, response: "Our QMS is ISO 9001 certified.", status: "ready", evidence: [] },
    { id: "a2", tenderId: "t1", questionId: "q-removed", response: "Written by a human before the buyer amended the pack.", status: "ready", evidence: [] },
  ];
  const orphans = orphanedAnswers(current, answers);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].questionId, "q-removed");
  assert.match(orphans[0].response, /Written by a human/);
  // The surviving answer is not reported as orphaned.
  assert.equal(orphans.some((o) => o.questionId === current.questions[0].id), false);
});

test("TLY-40 AC3: an empty answer for a removed question is not surfaced as work to keep", () => {
  const current = withStableIds(analysisWith([quality]));
  const answers: BidAnswer[] = [{ id: "a1", tenderId: "t1", questionId: "q-removed", response: "   ", status: "draft", evidence: [] }];
  assert.equal(orphanedAnswers(current, answers).length, 0);
});

test("TLY-40 AC4: a legacy analysis remaps its answers onto stable identifiers", () => {
  const legacy = analysisWith([quality]);
  const { analysis, questionIdMap } = remapLegacyAnalysis(legacy);
  assert.equal(analysis.schemaVersion, ANALYSIS_SCHEMA_VERSION);
  assert.equal(questionIdMap.get("model-invented-1"), analysis.questions[0].id);
});

test("TLY-40 AC1 and AC4: migration keeps a ready answer attached to its question", async () => {
  // This test touches the data layer, so it must own its schema: in CI DATABASE_URL
  // points at a Postgres service container that no earlier step has migrated.
  await initializeDatabase();
  const user = await createUser(`tly40-${Date.now()}@example.test`, "hash", "Migration Ltd");
  const tender = await upsertTender(user.id, {
    source: "etenders", externalId: `tly40-${Date.now()}`, title: "Stage 0 Energy Audit", authority: "Sample Authority",
    procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", metadata: {},
  });
  // Stored as it would have been before TLY-40: no version, model-invented ids.
  await saveTenderAnalysis(user.id, tender.id, analysisWith([quality]));
  await saveAnswer(tender.id, "model-invented-1", "Our QMS is ISO 9001 certified.", "ready");

  const counts = await migrateAnalysisSchema();
  assert.ok(counts.tenders >= 1);

  const answers = await listAnswers(tender.id);
  const expectedId = questionId(quality.title, quality.prompt);
  const migrated = answers.find((answer) => answer.questionId === expectedId);
  assert.ok(migrated, "the saved answer should now be keyed on the stable question id");
  assert.equal(migrated.status, "ready");
  assert.match(migrated.response, /ISO 9001/);

  // Running it again changes nothing.
  const second = await migrateAnalysisSchema();
  assert.equal(second.tenders, 0);
});

test("TLY-40 AC2: the serialized tender carries the schema version and an outdated flag", () => {
  const base = {
    id: "t1", accountId: "a1", source: "etenders", externalId: "X", title: "Stage 0 Energy Audit",
    authority: "Sample Authority", procedure: "Open", deadline: "26/03/2026", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED",
    metadata: {},
  } as unknown as TenderRecord;

  const current = serializeTender({ ...base, analysis: withStableIds(analysisWith([quality])) } as TenderRecord, []);
  assert.equal(current.schemaVersion, ANALYSIS_SCHEMA_VERSION);
  assert.ok((current.schemaVersion ?? "").length > 0);
  assert.equal(current.analysisOutdated, false);

  // AC6: an analysis stored under the previous shape is flagged, not rejected.
  const legacy = serializeTender({ ...base, analysis: analysisWith([quality]) } as TenderRecord, []);
  assert.equal(legacy.analysisOutdated, true);
  assert.equal(legacy.questions.length, 1);

  // A tender never analysed is not "outdated".
  const unanalysed = serializeTender({ ...base, analysis: null } as TenderRecord, []);
  assert.equal(unanalysed.analysisOutdated, false);
});

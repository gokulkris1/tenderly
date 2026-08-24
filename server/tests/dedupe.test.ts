import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { canonicalKey, mergeNotices, normaliseOjeuReference } from "../src/dedupe.js";
import { createUser, getTender, initializeDatabase, listAnswers, listTenders, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { PublicTender, TenderAnalysis } from "../src/types.js";

const notice = (over: Partial<PublicTender> = {}): PublicTender => ({
  externalId: "8796138", title: "Deep retrofit programme management",
  authority: "Dublin City Council", description: "Energy services for a retrofit",
  published: "06/08/2026 10:54:29", deadline: "27/08/2026 12:00:00", procedure: "Open",
  status: "Tender Submission", estimatedValue: "250,000.00",
  sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=8796138", ...over,
});

test("TLY-32 AC1: the two portals' spellings of one reference compare equal", () => {
  // eTenders publishes the classic OJEU form; TED publishes the number first.
  assert.equal(normaliseOjeuReference("2026/S 123-456789"), normaliseOjeuReference("456789-2026"));
  assert.equal(normaliseOjeuReference("2026/S 123-456789"), "ojeu:456789-2026");
  assert.equal(normaliseOjeuReference("no reference here"), null);
  assert.equal(normaliseOjeuReference(""), null);
  assert.equal(normaliseOjeuReference(undefined), null);
});

test("TLY-32: a bare year-like pair is not mistaken for a reference", () => {
  assert.equal(normaliseOjeuReference("1234-1899"), null, "outside the plausible year range");
  assert.equal(normaliseOjeuReference("12-2026"), null, "too few digits to be a notice number");
});

test("TLY-32 AC1 and AC2: one notice on both portals is listed once, with both links", () => {
  const merged = mergeNotices([
    { notice: { ...notice(), metadata: { "TED links for published notices": "2026/S 123-456789" } }, label: "eTenders" },
    { notice: notice({ externalId: "456789-2026", description: "", estimatedValue: "", sourceUrl: "https://ted.europa.eu/en/notice/456789-2026/pdf" }), label: "TED" },
  ]);

  assert.equal(merged.length, 1, "the same opportunity is one row");
  assert.deepEqual(merged[0].alternateSources.map((entry) => entry.label), ["eTenders", "TED"]);
  assert.equal(merged[0].mergeReason, "reference");
  assert.equal(merged[0].description, "Energy services for a retrofit",
    "the richer record wins: TED carries no description");
  assert.equal(merged[0].estimatedValue, "250,000.00");
});

test("TLY-32 AC3: two genuinely different notices from one buyer stay separate", () => {
  const merged = mergeNotices([
    { notice: notice({ title: "Deep retrofit programme management" }), label: "eTenders" },
    { notice: notice({ externalId: "8796139", title: "School catering services" }), label: "eTenders" },
  ]);
  assert.equal(merged.length, 2, "a different title is a different tender");
});

test("TLY-32 AC5: with no shared reference, an identical triple merges as heuristic", () => {
  const merged = mergeNotices([
    { notice: notice(), label: "eTenders" },
    { notice: notice({ externalId: "ted-1", deadline: "2026-08-27", sourceUrl: "https://ted.europa.eu/en/notice/ted-1/pdf" }), label: "TED" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].mergeReason, "heuristic", "the merge reason is recorded, not hidden");
  assert.match(merged[0].canonicalKey, /^heuristic:/);
});

test("TLY-32: the heuristic ignores time-of-day but not the date", () => {
  const sameDay = canonicalKey(notice({ deadline: "27/08/2026 12:00:00" })).key;
  const otherFormat = canonicalKey(notice({ deadline: "2026-08-27" })).key;
  const otherDay = canonicalKey(notice({ deadline: "28/08/2026 12:00:00" })).key;
  assert.equal(sameDay, otherFormat, "the two portals disagree about time routinely");
  assert.notEqual(sameDay, otherDay, "a different deadline is a different competition");
});

test("TLY-32: merging preserves the order a user is already reading", () => {
  const merged = mergeNotices([
    { notice: notice({ externalId: "a", title: "First" }), label: "eTenders" },
    { notice: notice({ externalId: "b", title: "Second" }), label: "eTenders" },
    { notice: notice({ externalId: "c", title: "First" }), label: "TED" },
  ]);
  assert.deepEqual(merged.map((item) => item.title), ["First", "Second"]);
});

test("TLY-32: a unique notice carries exactly one source and no merge reason", () => {
  const merged = mergeNotices([{ notice: notice(), label: "eTenders" }]);
  assert.equal(merged[0].alternateSources.length, 1);
  assert.equal(merged[0].mergeReason, undefined, "nothing was merged, so nothing is claimed");
});

const evidence = { sourceDocument: "ITT.pdf", quote: "Describe it.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], source: evidence }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
});

await initializeDatabase();

test("TLY-32 AC4: a later duplicate attaches to the record already worked on", async () => {
  const email = `dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), "Dedupe Ltd");

  // The eTenders record, imported and worked on first.
  const first = await upsertTender(user.id, {
    ...notice(), source: "etenders", status: "IMPORTED",
    metadata: { "TED links for published notices": "2026/S 123-456789" },
  });
  const stored = analysis();
  await saveTenderAnalysis(user.id, first.id, stored);
  const answer = await saveAnswer(first.id, stored.questions[0].id, "Work already done.", "ready", []);

  // The TED duplicate, ingested afterwards.
  const second = await upsertTender(user.id, {
    ...notice({ externalId: "456789-2026", description: "", estimatedValue: "", sourceUrl: "https://ted.europa.eu/en/notice/456789-2026/pdf" }),
    source: "ted", status: "IMPORTED", metadata: {},
  });

  assert.equal(second.id, first.id, "the duplicate must not create a second opportunity");
  const answers = await listAnswers(first.id);
  assert.equal(answers.length, 1, "the saved answer is still attached");
  assert.equal(answers[0].id, answer.id);
  assert.equal(answers[0].response, "Work already done.", "nothing a person wrote is lost to a re-ingest");

  const analysed = await getTender(user.id, first.id);
  assert.ok(analysed?.analysis, "the analysis survives too");

  const all = await listTenders(user.id);
  assert.equal(all.length, 1, "one opportunity, one row");
});

import assert from "node:assert/strict";
import test from "node:test";
import { assessRun, fieldCoverage, FIELD_EMPTY_THRESHOLD, REQUIRED_NOTICE_FIELDS, YIELD_FLOOR_RATIO } from "../src/ingestion-health.js";
import { initializeDatabase, latestIngestionRuns, recentIngestionYields, recordIngestionRun } from "../src/db.js";
import type { PublicTender } from "../src/types.js";

const notice = (over: Partial<PublicTender> = {}): PublicTender => ({
  externalId: "1", title: "A notice", authority: "Dublin City Council", description: "",
  published: "", deadline: "27/08/2026", procedure: "Open", status: "",
  estimatedValue: "", sourceUrl: "https://www.etenders.gov.ie/x", ...over,
});

test("TLY-33 AC1: a collapsed yield names both the floor and what was observed", () => {
  // Seven runs of about 40, then a run of 5.
  const history = [41, 39, 40, 38, 42, 40, 39];
  const verdict = assessRun({
    source: "etenders", noticesParsed: 5,
    fieldCoverage: fieldCoverage(Array.from({ length: 5 }, () => notice())),
    history,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.floor, Math.floor(40 * YIELD_FLOOR_RATIO));
  assert.match(verdict.alarms[0], /parsed 5 notices/);
  assert.match(verdict.alarms[0], /expected floor of 20/);
});

test("TLY-33 AC2: a slightly lower yield is not an alarm", () => {
  const verdict = assessRun({
    source: "etenders", noticesParsed: 38,
    fieldCoverage: fieldCoverage(Array.from({ length: 38 }, () => notice())),
    history: [41, 39, 40, 38, 42, 40, 39],
  });
  assert.equal(verdict.ok, true, "a source that dips slightly is not broken");
  assert.deepEqual(verdict.alarms, []);
});

test("TLY-33 AC3: a required field empty on most notices names that field", () => {
  // Every notice parsed, but nine in ten carry no deadline.
  const notices = [
    ...Array.from({ length: 36 }, () => notice({ deadline: "" })),
    ...Array.from({ length: 4 }, () => notice()),
  ];
  const verdict = assessRun({
    source: "etenders", noticesParsed: notices.length,
    fieldCoverage: fieldCoverage(notices), history: [40, 40, 40],
  });
  assert.equal(verdict.ok, false);
  const alarm = verdict.alarms.find((entry) => entry.includes("deadline"));
  assert.ok(alarm, "the degraded field is named, not just the run");
  assert.match(alarm, /90% of 40 parsed notices/);
});

test("TLY-33 AC5: a first run raises nothing about having no history", () => {
  const verdict = assessRun({
    source: "ted", noticesParsed: 3,
    fieldCoverage: fieldCoverage(Array.from({ length: 3 }, () => notice())),
    history: [],
  });
  assert.equal(verdict.ok, true, "a first run cannot be below its own median");
  assert.equal(verdict.floor, null);
  assert.deepEqual(verdict.alarms, []);
});

test("TLY-33: the floor follows the source's own scale", () => {
  const small = assessRun({ source: "small", noticesParsed: 7, fieldCoverage: fieldCoverage(Array.from({ length: 7 }, () => notice())), history: [8, 8, 9] });
  assert.equal(small.ok, true, "a source that normally yields 8 is not broken for yielding 7");

  const large = assessRun({ source: "large", noticesParsed: 7, fieldCoverage: fieldCoverage(Array.from({ length: 7 }, () => notice())), history: [400, 410, 395] });
  assert.equal(large.ok, false, "the same 7 from a source that yields 400 is a collapse");
});

test("TLY-33: an empty run reports the collapse without dividing by zero", () => {
  const verdict = assessRun({ source: "etenders", noticesParsed: 0, fieldCoverage: {}, history: [40, 40, 40] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.alarms.length, 1, "one clear alarm, not one per field");
  assert.match(verdict.alarms[0], /parsed 0 notices/);
});

test("TLY-33: coverage counts only fields that actually carry something", () => {
  const coverage = fieldCoverage([notice(), notice({ deadline: "   " }), notice({ authority: "" })]);
  assert.equal(coverage.deadline, 2, "whitespace is not a deadline");
  assert.equal(coverage.authority, 2);
  assert.equal(coverage.title, 3);
  for (const field of REQUIRED_NOTICE_FIELDS) assert.ok(field in coverage);
  assert.ok(FIELD_EMPTY_THRESHOLD > 0 && FIELD_EMPTY_THRESHOLD < 1);
});

test("TLY-33 AC4: the latest run per source is readable for /health", async () => {
  await initializeDatabase();
  const source = `test-source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await recordIngestionRun({ source, noticesSeen: 40, noticesParsed: 40, fieldCoverage: { deadline: 40 }, alarms: [] });
  await recordIngestionRun({ source, noticesSeen: 12, noticesParsed: 11, fieldCoverage: { deadline: 11 }, alarms: ["a warning"] });

  const yields = await recentIngestionYields(source);
  assert.deepEqual(yields.slice(0, 2), [11, 40], "newest first, so the median is over recent runs");

  const latest = await latestIngestionRuns();
  const mine = latest.find((run) => run.source === source);
  assert.equal(mine?.noticesParsed, 11, "the most recent run wins");
  assert.deepEqual(mine?.alarms, ["a warning"]);
  assert.ok(Date.parse(mine!.createdAt) > 0, "with the timestamp of that run");
});

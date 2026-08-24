import assert from "node:assert/strict";
import test from "node:test";
import { decide, unsupportedFigures } from "../src/decision.js";
import { deadlinePressure, irishPublicHolidays, parseDeadline, workingDaysUntil } from "../src/pressure.js";
import { RATIONALE_PROMPT } from "../src/prompts/index.js";
import type { EligibilityGate } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "Tenderers shall hold ISO 9001.", confidence: "HIGH" as const };
const gate = (requirement: string, status: EligibilityGate["status"]): EligibilityGate =>
  ({ id: requirement, requirement, bidderEvidence: "", status, action: "", evidence });

// Monday 1 June 2026 — which is itself the June bank holiday, so counts from
// here start on the Tuesday. That is the holiday handling doing its job.
const MONDAY = new Date(Date.UTC(2026, 5, 1));

test("TLY-47 AC4: St Patrick's Day is not a working day", () => {
  const holidays = irishPublicHolidays(2026);
  assert.ok(holidays.has("2026-03-17"));

  // 16 March 2026 is a Monday, so 16 and 18 are working days and 17 is not.
  const from = new Date(Date.UTC(2026, 2, 16));
  assert.equal(workingDaysUntil(new Date(Date.UTC(2026, 2, 18)), from), 2,
    "the holiday is excluded from the count");
});

test("TLY-47: the Irish holiday set is the real one, including observed days", () => {
  const holidays = irishPublicHolidays(2027);
  assert.ok(holidays.has("2027-03-17"), "St Patrick's Day");
  assert.ok(holidays.has("2027-02-01"), "St Brigid's Day is the first Monday in February");
  assert.ok(holidays.has("2027-03-29"), "Easter Monday");
  assert.ok(holidays.has("2027-10-25"), "the last Monday in October");
  // Christmas Day 2027 is a Saturday, so it is observed on the Monday.
  assert.ok(holidays.has("2027-12-27"), "a weekend Christmas is observed on the following Monday");
  assert.equal(irishPublicHolidays(2022).has("2022-02-07"), false, "St Brigid's Day only exists from 2023");
});

test("TLY-47 AC1: a distant deadline with a clear pipeline is Low, and states the days", () => {
  const pressure = deadlinePressure({
    // Four clear weeks from the Monday, with no holidays in that window.
    deadline: "26/06/2026", unresolvedItems: 0, otherBids: [], now: MONDAY,
  });
  assert.equal(pressure.band, "Low");
  assert.ok((pressure.workingDaysRemaining ?? 0) >= 18);
  assert.equal(pressure.competingBids.length, 0);
});

test("TLY-47 AC2: a near deadline with many open items is High and reports both", () => {
  const pressure = deadlinePressure({ deadline: "03/06/2026", unresolvedItems: 12, otherBids: [], now: MONDAY });
  assert.equal(pressure.band, "High");
  assert.equal(pressure.workingDaysRemaining, 2, "1 June is the June bank holiday, so only the 2nd and 3rd count");
  assert.equal(pressure.unresolvedItems, 12);
});

test("TLY-47 AC3: other bids closing the same week are counted and named", () => {
  const pressure = deadlinePressure({
    deadline: "12/06/2026", unresolvedItems: 0, now: MONDAY,
    otherBids: [
      { id: "a", title: "Framework for cloud hosting", deadline: "11/06/2026" },
      { id: "b", title: "Network refresh", deadline: "15/06/2026" },
      { id: "c", title: "Something in the autumn", deadline: "12/10/2026" },
    ],
  });
  assert.equal(pressure.competingBids.length, 2, "only the two closing in the same week count");
  assert.deepEqual(pressure.competingBids.map((bid) => bid.title), ["Framework for cloud hosting", "Network refresh"]);
});

test("TLY-47 AC5: an unreadable deadline gets the marker and no band", () => {
  const pressure = deadlinePressure({ deadline: "Verify deadline", unresolvedItems: 3, otherBids: [], now: MONDAY });
  assert.equal(pressure.band, undefined, "asserting a band for a date we could not find would be a guess");
  assert.equal(pressure.workingDaysRemaining, null);
  assert.equal(pressure.note, "[INPUT NEEDED: submission deadline]");

  assert.equal(parseDeadline("31/02/2026"), null, "an impossible date is not silently rolled over");
  assert.equal(parseDeadline(""), null);
  assert.equal(parseDeadline(undefined), null);
});

test("TLY-49 AC1: all gates passing with a good score and time is a Go", () => {
  const result = decide({
    gates: [gate("Tax clearance", "PASS"), gate("Insurance", "PASS")],
    fitScore: 78,
    pressure: { band: "Low", workingDaysRemaining: 20, unresolvedItems: 0, competingBids: [] },
    partnerCloseable: false,
  });
  assert.equal(result.decision, "GO");
  assert.ok(result.facts.some((fact) => fact.includes("78")), "the fit score is a fact the rationale may cite");
  assert.ok(result.facts.some((fact) => fact.includes("2 of 2 gates pass")));
  assert.ok(result.facts.some((fact) => fact.includes("Deadline pressure Low")));
});

test("TLY-49 AC2: a failing gate can never be a Go, whatever the score says", () => {
  const closeable = decide({
    gates: [gate("Minimum turnover", "FAIL"), gate("Tax clearance", "PASS")],
    fitScore: 95, partnerCloseable: true,
  });
  assert.equal(closeable.decision, "PARTNER");
  assert.ok(closeable.facts.some((fact) => fact.includes("Minimum turnover")), "the failing gate is named");

  const notCloseable = decide({
    gates: [gate("Minimum turnover", "FAIL")],
    fitScore: 95, partnerCloseable: false,
  });
  assert.equal(notCloseable.decision, "NO_GO");
});

test("TLY-49 AC3: unresolved gates force Review and are listed", () => {
  const result = decide({
    gates: [gate("ISO 27001", "REVIEW"), gate("Insurance cover", "REVIEW"), gate("Tax clearance", "PASS")],
    fitScore: 88, partnerCloseable: false,
  });
  assert.equal(result.decision, "REVIEW");
  const unresolved = result.facts.find((fact) => fact.startsWith("Unresolved gates"));
  assert.match(unresolved ?? "", /ISO 27001/);
  assert.match(unresolved ?? "", /Insurance cover/);
});

test("TLY-49 AC6: resolving the evidence turns the same tender into a Go", () => {
  const before = decide({ gates: [gate("ISO 27001", "REVIEW"), gate("Insurance", "REVIEW")], fitScore: 80, partnerCloseable: false });
  assert.equal(before.decision, "REVIEW");

  const after = decide({
    gates: [gate("ISO 27001", "PASS"), gate("Insurance", "PASS")],
    fitScore: 80, partnerCloseable: false,
    pressure: { band: "Low", workingDaysRemaining: 15, unresolvedItems: 0, competingBids: [] },
  });
  assert.equal(after.decision, "GO");
});

test("TLY-49 AC4: a rationale citing a figure it was not given is detected", () => {
  const facts = ["Fit score 78", "2 of 2 gates pass", "Deadline pressure Low, 20 working days remaining"];
  assert.deepEqual(unsupportedFigures("Your fit score of 78 and 20 working days make this a Go.", facts), []);
  assert.deepEqual(unsupportedFigures("This buyer awards 14 contracts a year, so bid.", facts), ["14"],
    "a fabricated figure on a bid recommendation is exactly what must not reach the user");
  assert.deepEqual(unsupportedFigures("Every gate passes and there is time to bid.", facts), []);
});

test("TLY-49 AC5: the band survives without a rationale", () => {
  // decide() takes no model input at all, which is what makes AC5 true: the
  // recommendation cannot depend on a call that might not happen.
  const result = decide({ gates: [gate("Tax clearance", "PASS")], fitScore: 60, partnerCloseable: false,
    pressure: { band: "Medium", workingDaysRemaining: 9, unresolvedItems: 1, competingBids: [] } });
  assert.equal(result.decision, "GO");
  assert.ok(result.reason.length > 0, "the band always carries its own one-line reason");
});

test("TLY-49: nothing checked is Review, not a pass by default", () => {
  const result = decide({ gates: [], fitScore: 90, partnerCloseable: false });
  assert.equal(result.decision, "REVIEW");
  assert.match(result.reason, /nothing has been checked/);
});

test("TLY-49: no time left is a Review even when every gate passes", () => {
  const result = decide({
    gates: [gate("Tax clearance", "PASS")], fitScore: 85, partnerCloseable: false,
    pressure: { band: "High", workingDaysRemaining: 2, unresolvedItems: 6, competingBids: [] },
  });
  assert.equal(result.decision, "REVIEW");
  assert.match(result.reason, /little time/);
});

test("TLY-49: the prompt forbids the model inventing or softening anything", () => {
  assert.match(RATIONALE_PROMPT, /Never state a number that is not in the facts/);
  assert.match(RATIONALE_PROMPT, /Never soften a No-Go into a maybe/);
  assert.match(RATIONALE_PROMPT, /You do not decide it/);
});

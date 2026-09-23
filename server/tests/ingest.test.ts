import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { cpvFamilyMatch, decideIngest } from "../src/ingest.js";

/** The profile Ingenie Technologies actually asked for: the whole IT services family. */
const IT_SERVICES = ["72000000"];
const future = "26/03/2027";
const past = "01/01/2020";

test("TLY-224: a child CPV is covered by the family the company registered", () => {
  // 72212000 is software programming; 72000000 is IT services. Buyers tag the
  // child, companies register the parent, and the product has to bridge that.
  assert.equal(cpvFamilyMatch("72212000", IT_SERVICES), "72000000");
  assert.equal(cpvFamilyMatch("72000000", IT_SERVICES), "72000000");
  assert.equal(cpvFamilyMatch("72260000", IT_SERVICES), "72000000");
});

test("TLY-224: a code outside the family is not covered", () => {
  assert.equal(cpvFamilyMatch("45000000", IT_SERVICES), null, "construction is not IT services");
  assert.equal(cpvFamilyMatch("48000000", IT_SERVICES), null, "software packages is a sibling family, not a child");
  assert.equal(cpvFamilyMatch(null, IT_SERVICES), null);
  assert.equal(cpvFamilyMatch("not a code", IT_SERVICES), null);
});

test("TLY-224: a CPV family match lands on the board even though the score is below the threshold", () => {
  // This is the whole point. An ancestor match scores 22 and the threshold is
  // 45, so before this rule every real 72xxxxxx notice was silently dropped.
  const verdict = decideIngest({
    deadline: future, noticeCpv: "72212000", profileCpvCodes: IT_SERVICES, score: 22, threshold: 45,
  });
  assert.equal(verdict.ingest, true);
  assert.equal(verdict.matchedCpv, "72000000");
  assert.equal(verdict.reason, "CPV 72212000 sits under your 72000000");
});

test("TLY-224: an exact match says so rather than claiming it sits underneath itself", () => {
  const verdict = decideIngest({
    deadline: future, noticeCpv: "72000000", profileCpvCodes: IT_SERVICES, score: 45, threshold: 45,
  });
  assert.equal(verdict.reason, "CPV 72000000 matches your profile");
});

test("TLY-224: a tender outside the family still needs the score to earn its place", () => {
  const scored = decideIngest({
    deadline: future, noticeCpv: "45000000", profileCpvCodes: IT_SERVICES, score: 60, threshold: 45,
  });
  assert.equal(scored.ingest, true);
  assert.equal(scored.reason, "Scored 60 against a threshold of 45");

  const unscored = decideIngest({
    deadline: future, noticeCpv: "45000000", profileCpvCodes: IT_SERVICES, score: 12, threshold: 45,
  });
  assert.equal(unscored.ingest, false);
  assert.match(unscored.reason, /outside your profile/);
});

test("TLY-171: a closed tender never reaches the board, however well it matches", () => {
  const verdict = decideIngest({
    deadline: past, noticeCpv: "72212000", profileCpvCodes: IT_SERVICES, score: 95, threshold: 45,
  });
  assert.equal(verdict.ingest, false);
  assert.match(verdict.reason, /^Closed: the deadline passed on /,
    "a board carrying tenders nobody can bid for is a board that gets ignored");
});

test("TLY-171: no stated deadline is not evidence that it closed", () => {
  const verdict = decideIngest({
    deadline: "", noticeCpv: "72212000", profileCpvCodes: IT_SERVICES, score: 0, threshold: 45,
  });
  assert.equal(verdict.ingest, true, "silence is not a closed tender");
  assert.equal(verdict.deadlineUnknown, true, "but the board must not imply it is comfortably open");
});

test("TLY-223: a notice whose CPV could not be read falls back to the score", () => {
  // Enrichment failing is a fact about a web request, not about the tender.
  const rescued = decideIngest({
    deadline: future, noticeCpv: null, profileCpvCodes: IT_SERVICES, score: 50, threshold: 45,
  });
  assert.equal(rescued.ingest, true);

  const dropped = decideIngest({
    deadline: future, noticeCpv: null, profileCpvCodes: IT_SERVICES, score: 10, threshold: 45,
  });
  assert.equal(dropped.ingest, false);
  assert.equal(dropped.reason, "No CPV published and it scored 10");
});

test("TLY-224: an empty profile does not silently match everything", () => {
  const verdict = decideIngest({
    deadline: future, noticeCpv: "72212000", profileCpvCodes: [], score: 0, threshold: 45,
  });
  assert.equal(verdict.ingest, false,
    "a company that has set no CPV codes has not asked for every tender in Ireland");
});

test("TLY-224: the reason is a sentence the board can show without rewriting it", () => {
  for (const verdict of [
    decideIngest({ deadline: future, noticeCpv: "72212000", profileCpvCodes: IT_SERVICES, score: 22, threshold: 45 }),
    decideIngest({ deadline: past, noticeCpv: "72212000", profileCpvCodes: IT_SERVICES, score: 22, threshold: 45 }),
    decideIngest({ deadline: future, noticeCpv: null, profileCpvCodes: IT_SERVICES, score: 10, threshold: 45 }),
  ]) {
    assert.match(verdict.reason, /^[A-Z]/, "starts like a sentence");
    assert.ok(verdict.reason.length > 12 && !verdict.reason.includes("undefined"));
  }
});

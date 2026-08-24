import assert from "node:assert/strict";
import test from "node:test";
import { allCpvCodes, cpvAncestors, cpvDescendants, cpvLabel, extractCpvCode, normaliseCpv } from "../src/cpv.js";
import { tenderCpv } from "../src/serializers.js";
import type { TenderRecord } from "../src/types.js";

const tender = (metadata: Record<string, unknown>) => ({
  id: "t", accountId: "a", source: "etenders", externalId: "X", title: "T", authority: "A",
  procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "IMPORTED", metadata, analysis: null,
}) as unknown as TenderRecord;

test("TLY-31 AC1: a hyphenated code normalises to eight digits with its description", () => {
  const entry = normaliseCpv("71314000-5");
  assert.ok(entry);
  assert.equal(entry.code, "71314000");
  assert.equal(entry.description, "Energy and related services");
  assert.equal(entry.checkDigit, "2", "the check digit comes from the published list, not from the input");
});

test("TLY-31 AC1: the ancestor chain is the broader codes that actually exist", () => {
  const chain = cpvAncestors("71314000").map((entry) => entry.code);
  // 71310000 is in the published list, so it belongs in the chain: dropping it
  // would make a company registered at that level miss this notice.
  assert.deepEqual(chain, ["71310000", "71300000", "71000000"]);
  assert.deepEqual(cpvAncestors("71000000"), [], "a division has no broader code");
});

test("TLY-31: the chain never invents a code the list does not contain", () => {
  const codes = new Set(allCpvCodes().map((entry) => entry.code));
  for (const sample of ["45213316", "72212000", "03111000", "98910000"]) {
    for (const ancestor of cpvAncestors(sample)) {
      assert.ok(codes.has(ancestor.code), `${ancestor.code} is not a published code`);
    }
  }
});

test("TLY-31 AC2: a raw string with a code and a description is shown canonically", () => {
  const wire = tenderCpv(tender({ "CPV Codes": "71314000-5 Energy and related services" }));
  assert.equal(wire?.recognised, true);
  assert.equal(cpvLabel({ code: wire!.code!, description: wire!.description! }), "71314000 — Energy and related services");
});

test("TLY-31 AC3: an unrecognised code keeps its own wording and does not fail", () => {
  const wire = tenderCpv(tender({ "CPV Codes": "99999999" }));
  assert.equal(wire?.recognised, false);
  assert.equal(wire?.raw, "99999999");
  assert.equal(wire?.description, undefined, "no description may be invented for a code we do not hold");
  assert.equal(normaliseCpv("99999999"), null);
  assert.equal(normaliseCpv("Energy services, no code given"), null);
  assert.equal(normaliseCpv(""), null);
  assert.equal(normaliseCpv(undefined), null);
});

test("TLY-31: a longer number is not silently truncated to eight digits", () => {
  assert.equal(extractCpvCode("713140001234"), null, "a twelve-digit number is not a CPV code");
  assert.equal(extractCpvCode("ref 71314000-5 applies"), "71314000");
  assert.equal(extractCpvCode("71314000"), "71314000");
});

test("TLY-31 AC5: descendants of a division include its groups, classes and categories", () => {
  const descendants = cpvDescendants("71000000").map((entry) => entry.code);
  assert.ok(descendants.includes("71300000"), "a group under the division");
  assert.ok(descendants.includes("71310000"), "a class under that group");
  assert.ok(descendants.includes("71314000"), "a category under that class");
  assert.ok(!descendants.includes("71000000"), "a code is not its own descendant");
  assert.ok(descendants.every((code) => code.startsWith("71")), "nothing outside the division leaks in");

  const narrower = cpvDescendants("71310000").map((entry) => entry.code);
  assert.ok(narrower.includes("71314000"));
  assert.ok(!narrower.includes("71300000"), "a broader code is not a descendant");
});

test("TLY-31: the committed list is the full CPV 2008 set, with leading zeros intact", () => {
  const codes = allCpvCodes();
  assert.equal(codes.length, 9454, "the published CPV 2008 list has 9,454 codes");
  assert.ok(codes.every((entry) => /^\d{8}$/.test(entry.code)));
  assert.ok(codes.some((entry) => entry.code.startsWith("0")), "leading zeros survive the CSV round trip");
  assert.equal(normaliseCpv("03000000")?.description, "Agricultural, farming, fishing, forestry and related products");
});

test("TLY-31: level rises from division to the most detailed category", () => {
  assert.equal(normaliseCpv("71000000")?.level, 1);
  assert.equal(normaliseCpv("71300000")?.level, 2);
  assert.equal(normaliseCpv("71310000")?.level, 3);
  assert.equal(normaliseCpv("71314000")?.level, 4);
});

test("TLY-31: a notice with no CPV field at all carries none, rather than an empty one", () => {
  assert.equal(tenderCpv(tender({})), undefined);
  assert.equal(tenderCpv(tender({ "CPV Codes": "   " })), undefined);
});

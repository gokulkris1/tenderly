import assert from "node:assert/strict";
import test from "node:test";
import { SECTOR_PRESETS, matchNotice, presetBySlug, profileCpvCodes, profileKeywords } from "../src/sectors.js";

test("TLY-34 AC7: a preset expands to the CPV codes it covers", () => {
  const dev = presetBySlug("software-development");
  assert.ok(dev);
  const codes = dev.cpvCodes.map((entry) => entry.code);
  // Official CPV 2008 codes — a wrong one silently hides real opportunities.
  assert.ok(codes.includes("72230000"), "custom software development");
  assert.ok(codes.includes("48000000"), "software package and information systems");
  const testing = presetBySlug("software-testing");
  assert.ok(testing);
  assert.ok(testing.cpvCodes.map((e) => e.code).includes("72820000"), "computer testing services");
});

test("TLY-34 AC8: a notice matching either selected preset is kept, and says which matched", () => {
  const sectors = ["software-development", "software-testing"];
  const dev = matchNotice("Provision of a Custom Software Development Framework", sectors, []);
  assert.equal(dev.length > 0, true);
  assert.equal(dev[0].sector, "software-development");

  const qa = matchNotice("Independent Software Testing and Quality Assurance Services", sectors, []);
  assert.ok(qa.some((r) => r.sector === "software-testing"), "should be attributed to the testing preset");
});

test("TLY-34: 'uat' does not match inside 'valuation'", () => {
  // Found against live eTenders data: "Property and Valuation Services" was being
  // offered to a software bidder because "uat" appears inside "valuation".
  const reasons = matchNotice("Property and Valuation Services", ["software-testing"], []);
  assert.deepEqual(reasons, []);
});

test("TLY-34: generic 'testing' only counts when the notice is about technology", () => {
  // Also found live: radon testing of properties is not software testing.
  assert.deepEqual(matchNotice("PROVISION OF RADON TESTING OF PROPERTIES FOR GALWAY", ["software-testing"], []), []);
  assert.deepEqual(matchNotice("Water quality testing services", ["software-testing"], []), []);
  const real = matchNotice("Testing services for the new payments software platform", ["software-testing"], []);
  assert.equal(real.length > 0, true);
});

test("TLY-34: generic 'development' does not match property development", () => {
  assert.deepEqual(matchNotice("Site development works at Ballymun", ["software-development"], []), []);
  assert.ok(matchNotice("Redevelopment of the CARO.ie website", ["software-development"], []).length > 0);
});

test("TLY-34: an unrelated notice matches nothing and is filtered out", () => {
  const reasons = matchNotice(
    "Killocrim NS, Listowel, Co. Kerry - Emergency Drainage Works",
    ["software-development", "software-testing"],
    [],
  );
  assert.deepEqual(reasons, []);
});

test("TLY-34: a user's own keyword matches and is labelled as theirs", () => {
  const reasons = matchNotice("Supply of GIS mapping services", [], ["gis"]);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].sector, "keyword");
  assert.equal(reasons[0].keyword, "gis");
});

test("TLY-34 AC9: hand-entered CPV codes are kept alongside the preset codes", () => {
  const codes = profileCpvCodes(["software-testing"], ["79212000"]);
  assert.ok(codes.includes("72820000"), "from the preset");
  assert.ok(codes.includes("79212000"), "entered by hand");
});

test("TLY-34: keyword expansion de-duplicates and lower-cases", () => {
  const keywords = profileKeywords(["software-development"], ["Software", "  API  "]);
  assert.equal(keywords.filter((k) => k === "software").length, 1);
  assert.ok(keywords.includes("api"));
});

test("TLY-34: every preset is usable — it has a label, a description and at least one code", () => {
  for (const preset of SECTOR_PRESETS) {
    assert.ok(preset.label.length > 0, `${preset.slug} label`);
    assert.ok(preset.description.length > 0, `${preset.slug} description`);
    assert.ok(preset.keywords.length > 0, `${preset.slug} keywords`);
    assert.ok(preset.cpvCodes.length > 0, `${preset.slug} cpv`);
    for (const entry of preset.cpvCodes) assert.match(entry.code, /^[0-9]{8}$/, `${preset.slug} ${entry.code}`);
  }
});

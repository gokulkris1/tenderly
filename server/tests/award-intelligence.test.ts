import assert from "node:assert/strict";
import test from "node:test";
import { awardIntelligence, companyWonBefore, initializeDatabase, saveAwards } from "../src/db.js";
import type { AwardRecord } from "../src/sources/ogp.js";

const award = (over: Partial<AwardRecord>): AwardRecord => ({
  externalId: `x-${Math.random().toString(36).slice(2)}`,
  authority: "Health Service Executive",
  title: "Energy audit services",
  cpv: "71314000",
  cpvDescription: "Energy and related services",
  procedure: "Open",
  publishedOn: "2025-01-01",
  awardedOn: "2025-03-01",
  awardedValue: 100000,
  estimatedValue: null,
  suppliers: "Acme Energy Ltd",
  bidsReceived: 3,
  smeBidsReceived: 2,
  ...over,
});

await initializeDatabase();

test("TLY-48 AC3: no history for a buyer and CPV says so rather than guessing", async () => {
  const result = await awardIntelligence("Authority With No History", "99999999");
  assert.equal(result.awards, 0);
  assert.equal(result.medianValue, null);
  assert.deepEqual(result.topSuppliers, []);
  assert.match(result.licenceNote, /CC-BY-4\.0/);
});

test("TLY-48 AC1: counts, median and top suppliers come from stored rows", async () => {
  await saveAwards([
    award({ externalId: "a1", awardedValue: 50000, suppliers: "Acme Energy Ltd" }),
    award({ externalId: "a2", awardedValue: 100000, suppliers: "Acme Energy Ltd" }),
    award({ externalId: "a3", awardedValue: 150000, suppliers: "Beta Consulting" }),
    award({ externalId: "a4", awardedValue: 200000, suppliers: "Acme Energy Ltd" }),
    award({ externalId: "a5", awardedValue: 250000, suppliers: "Gamma Audits" }),
    award({ externalId: "a6", awardedValue: 300000, suppliers: "Beta Consulting" }),
  ]);
  const result = await awardIntelligence("Health Service Executive", "71314000");
  assert.equal(result.awards, 6);
  assert.equal(result.minValue, 50000);
  assert.equal(result.maxValue, 300000);
  assert.ok(result.medianValue && result.medianValue >= 150000 && result.medianValue <= 200000, `median ${result.medianValue}`);
  assert.equal(result.topSuppliers[0].supplier, "Acme Energy Ltd");
  assert.equal(result.topSuppliers[0].awards, 3);
  assert.ok(result.topSuppliers.length <= 3);
  assert.equal(result.relatedCpv, false);
});

test("TLY-48 AC4: a small sample is reported honestly, not smoothed over", async () => {
  await saveAwards([
    award({ externalId: "s1", authority: "Small Authority", cpv: "48000000", awardedValue: 10000 }),
    award({ externalId: "s2", authority: "Small Authority", cpv: "48000000", awardedValue: 20000 }),
  ]);
  const result = await awardIntelligence("Small Authority", "48000000");
  assert.equal(result.awards, 2);
  assert.ok(result.awards < 5, "the caller warns below five awards");
});

test("TLY-48 AC6: an exact CPV with no history falls back to its division, flagged", async () => {
  await saveAwards([award({ externalId: "r1", authority: "Related Authority", cpv: "71300000", awardedValue: 90000 })]);
  const exact = await awardIntelligence("Related Authority", "71314000");
  assert.equal(exact.awards, 1, "should have fallen back to the 71 division");
  assert.equal(exact.relatedCpv, true, "and must say the figures are for a related CPV");
});

test("TLY-48 AC2: the company is recognised among the buyer's suppliers", async () => {
  await saveAwards([award({ externalId: "c1", authority: "Repeat Buyer", suppliers: "Tenderly Demo Ltd and partners" })]);
  assert.equal(await companyWonBefore("Repeat Buyer", "Tenderly Demo Ltd"), 1);
  assert.equal(await companyWonBefore("Repeat Buyer", "Some Other Company"), 0);
  // An empty company name must not match everything.
  assert.equal(await companyWonBefore("Repeat Buyer", "   "), 0);
});

test("TLY-48: an unknown authority yields nothing rather than the whole table", async () => {
  const result = await awardIntelligence("", "71314000");
  assert.equal(result.awards, 0);
});

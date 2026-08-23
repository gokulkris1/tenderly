import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHeaders, awardId, cell, normaliseCpv, parseCount, parseIrishDate,
  parseMoney, rowToAward, splitCsvLine,
} from "../src/sources/ogp.js";

// The real header, copied from the published file on 2026-08-23.
const HEADER = splitCsvLine(
  "﻿Tender ID,Contracting Authority,Tender Name,Notice Published Date,Directive,Competition Type,Main Cpv Code,Main Cpv Code Description,Additional CPV Codes on CFT,Spend Category,Contract Type,Threshold Level,Procedure,Tender Submission Deadline,Evaluation Type,Notice Estimated Value,Contract Duration (Months),Cancelled Date,Award Published,Awarded Value,No of Bids Received,No of SMEs Bids Received,Awarded Suppliers,No of Awarded SMEs,TED Notice Link,TED CAN Link,Platform",
);

test("TLY-30: empty cells arrive as the string NULL, not as blanks", () => {
  assert.equal(cell("NULL"), "");
  assert.equal(cell("  NULL  "), "");
  assert.equal(cell(""), "");
  assert.equal(cell("Revenue"), "Revenue");
});

test("TLY-30: a quoted field containing commas does not corrupt the row", () => {
  // The additional-CPV column really does look like this in the file.
  const values = splitCsvLine('70917,Dept,"Register of Electors, Forms","2,282,100,079",Open');
  assert.deepEqual(values, ["70917", "Dept", "Register of Electors, Forms", "2,282,100,079", "Open"]);
});

test("TLY-30 AC4: an impossible date is rejected rather than rolled over", () => {
  assert.equal(parseIrishDate("02/01/2013"), "2013-01-02");
  assert.equal(parseIrishDate("31/02/2024"), null, "31 February must not become 2 March");
  assert.equal(parseIrishDate("NULL"), null);
  assert.equal(parseIrishDate("2013-01-02"), null, "ISO input is not the dataset's format");
});

test("TLY-30: money and counts tolerate the formats actually present", () => {
  assert.equal(parseMoney("49000"), 49000);
  assert.equal(parseMoney("€1,250,000.50"), 1250000.5);
  assert.equal(parseMoney("NULL"), null);
  assert.equal(parseCount("12"), 12);
  assert.equal(parseCount("NULL"), null);
});

test("TLY-30: only an 8-digit CPV is kept", () => {
  assert.equal(normaliseCpv("22821000"), "22821000");
  assert.equal(normaliseCpv("72230000-6"), "");   // 9 digits once the dash is stripped
  assert.equal(normaliseCpv("NULL"), "");
});

test("TLY-30 AC1: a real row maps to an award record", () => {
  const line = '70917,Department of Housing,Register of Electors Forms,02/01/2013,NULL,Bespoke,22821000,Electoral forms.,"2,282,100",Print,Supplies,National,Open Procedure,24/01/2013,NULL,NULL,NULL,NULL,31/01/2013,48000,3,2,Acme Print Ltd,1,NULL,NULL,EUS Platform';
  const award = rowToAward(HEADER, splitCsvLine(line));
  assert.ok(award);
  assert.equal(award.externalId, "70917");
  assert.equal(award.authority, "Department of Housing");
  assert.equal(award.cpv, "22821000");
  assert.equal(award.awardedOn, "2013-01-31");
  assert.equal(award.awardedValue, 48000);
  assert.equal(award.suppliers, "Acme Print Ltd");
  assert.equal(award.bidsReceived, 3);
  assert.equal(award.smeBidsReceived, 2);
});

test("TLY-30 AC4: a row with no tender id or authority is skipped, not stored half-formed", () => {
  const noId = rowToAward(HEADER, splitCsvLine("NULL,Dept,Title,02/01/2013"));
  assert.equal(noId, null);
  const noAuthority = rowToAward(HEADER, splitCsvLine("70917,NULL,Title,02/01/2013"));
  assert.equal(noAuthority, null);
});

test("TLY-30 AC5: a header without the columns we rely on stops the import", () => {
  assert.doesNotThrow(() => assertHeaders(HEADER));
  assert.throws(() => assertHeaders(["Something", "Else"]), /missing column/i);
});

test("TLY-30 AC2: the same tender id always yields the same row id, so re-import updates", () => {
  assert.equal(awardId("70917"), awardId("70917"));
  assert.notEqual(awardId("70917"), awardId("70918"));
  assert.match(awardId("70917"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("TLY-30 AC5: the licence obligation travels with the data", async () => {
  const { AWARD_DATA_ATTRIBUTION } = await import("../src/sources/ogp.js");
  assert.match(AWARD_DATA_ATTRIBUTION, /CC-BY-4\.0/);
  assert.match(AWARD_DATA_ATTRIBUTION, /Office of Government Procurement/);
  const migration = (await import("node:fs")).readFileSync("migrations/003_award_history.sql", "utf8");
  assert.match(migration, /licence_note/);
  // Check the statements, not the comments — the comment explains why there is no account_id.
  const sql = migration.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.equal(/account_id/.test(sql), false, "award history is shared reference data, not tenant-scoped");
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IRISH_IT_QUERY, mainCpv, mapNotices, noticeToPublicTender, pickLanguage, searchTed } from "../src/sources/ted.js";

// A real response captured from api.ted.europa.eu on 2026-08-23.
const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/ted/search-ie-it.json"), "utf8"));

test("TLY-29 AC6: the fixture is a real TED payload and needs no network", () => {
  assert.ok(Array.isArray(fixture.notices));
  assert.ok(fixture.notices.length >= 3, "fixture should carry several notices");
});

test("TLY-29: language-keyed fields are flattened, whether string- or array-valued", () => {
  // notice-title maps a language to a string; buyer-name maps it to an array.
  assert.equal(pickLanguage({ eng: "Consultancy services", fra: "Services" }), "Consultancy services");
  assert.equal(pickLanguage({ eng: ["The Office of Government Procurement"] }), "The Office of Government Procurement");
  assert.equal(pickLanguage("already a string"), "already a string");
  assert.equal(pickLanguage(undefined), "");
  // Falls back to whatever language is present rather than losing the notice.
  assert.equal(pickLanguage({ lav: "Konsultaciju" }), "Konsultaciju");
});

test("TLY-29: a language-keyed object is never stored as [object Object]", () => {
  const { items } = mapNotices(fixture.notices);
  for (const item of items) {
    assert.equal(item.title.includes("[object"), false, item.title);
    assert.equal(item.authority.includes("[object"), false, item.authority);
  }
});

test("TLY-29 AC1: notices map to the publication number and real fields", () => {
  const { items } = mapNotices(fixture.notices);
  assert.equal(items.length, fixture.notices.length);
  for (const item of items) {
    assert.match(item.externalId, /^\d+-\d{4}$/, `publication number: ${item.externalId}`);
    assert.ok(item.title.length > 0);
    assert.match(item.sourceUrl, /^https:\/\/ted\.europa\.eu\/en\/notice\//);
  }
});

test("TLY-29: CPV is taken from the array, and rejected when unusable", () => {
  assert.equal(mainCpv(["72221000", "72224000"]), "72221000");
  assert.equal(mainCpv("48000000"), "48000000");
  assert.equal(mainCpv(["7222"]), "");
  assert.equal(mainCpv(undefined), "");
});

test("TLY-29 AC4: a notice with no CPV is still kept, with a warning", () => {
  const { items, warnings } = mapNotices([
    { "publication-number": "123456-2026", "notice-title": { eng: "A notice with no CPV" }, "buyer-name": { eng: ["A Buyer"] } },
  ]);
  assert.equal(items.length, 1, "a real notice must not be dropped for a missing CPV");
  assert.ok(warnings.some((w) => w.includes("123456-2026") && /CPV/.test(w)));
});

test("TLY-29: a notice with no publication number is skipped, not stored half-formed", () => {
  const { items, warnings } = mapNotices([{ "notice-title": { eng: "Nameless" } }]);
  assert.deepEqual(items, []);
  assert.equal(warnings.length, 1);
});

test("TLY-29 AC5: a 429 is retried after the interval the service asks for", async () => {
  const calls: number[] = [];
  let attempt = 0;
  const fetchImpl = (async () => {
    calls.push(Date.now());
    attempt++;
    if (attempt === 1) return new Response("", { status: 429, headers: { "retry-after": "1" } });
    return new Response(JSON.stringify({ notices: fixture.notices.slice(0, 2) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const result = await searchTed({ fetchImpl, maxRetries: 2 });
  assert.equal(attempt, 2, "should have retried once");
  assert.equal(result.items.length, 2);
  assert.ok(result.warnings.some((w) => /retry/i.test(w)));
  assert.ok(calls[1] - calls[0] >= 900, "must wait the interval rather than hammering the service");
});

test("TLY-29 AC5: repeated 429s give up and report rather than looping", async () => {
  const fetchImpl = (async () => new Response("", { status: 429, headers: { "retry-after": "1" } })) as unknown as typeof fetch;
  const result = await searchTed({ fetchImpl, maxRetries: 1 });
  assert.deepEqual(result.items, []);
  assert.ok(result.warnings.some((w) => /rate limit/i.test(w)));
});

test("TLY-29: a non-200 reports rather than throwing, so eTenders results survive", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const result = await searchTed({ fetchImpl });
  assert.deepEqual(result.items, []);
  assert.ok(result.warnings.some((w) => /503/.test(w)));
});

test("TLY-29: the query targets Irish IT notices", () => {
  assert.match(IRISH_IT_QUERY, /place-of-performance=IRL/);
  assert.match(IRISH_IT_QUERY, /classification-cpv=72\*/);
});

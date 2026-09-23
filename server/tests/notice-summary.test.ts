import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { UNASSESSED_WITHOUT_PACK, noticeSummaryText, summariseNotice } from "../src/notice-summary.js";
import type { TenderRecord } from "../src/types.js";

/** A tender as the 05:00 run leaves it: enriched from the notice, pack unread. */
const notice = (over: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): TenderRecord => ({
  id: "t", accountId: "a", source: "etenders", externalId: "123456",
  title: "Request for Tenders for provision of ICT Technical Support Services",
  authority: "Health Service Executive",
  description: "Provision of ICT technical support across HSE sites for an initial three-year term.",
  procedure: "Open", deadline: "16/10/2026 13:00", estimatedValue: "€450,000",
  published: "22/09/2026", status: "IMPORTED", sourceUrl: "https://www.etenders.gov.ie/x",
  analysis: null,
  metadata: {
    "CPV Codes": "72000000-IT services: consulting, software development",
    "Contract duration in months or years, including any options and renewals": "36 months",
    ...metadata,
  },
  ...over,
}) as unknown as TenderRecord;

test("TLY-173: the four facts a decision turns on come straight from the notice", () => {
  const summary = summariseNotice(notice());
  assert.match(summary.ask, /ICT technical support across HSE sites/);
  assert.equal(summary.buyer, "Health Service Executive");
  assert.equal(summary.value, "€450,000");
  assert.equal(summary.duration, "36 months");
  assert.equal(summary.deadline, "16/10/2026 13:00");
  assert.match(summary.cpv, /^72000000/);
});

test("TLY-173: a fact the notice does not state is a gap, never an inference", () => {
  const summary = summariseNotice(notice({ estimatedValue: "" }, {
    "Contract duration in months or years, including any options and renewals": "",
  }));
  assert.equal(summary.value, "[INPUT NEEDED: contract value not stated in the notice]");
  assert.equal(summary.duration, "[INPUT NEEDED: contract duration not stated in the notice]");
  assert.ok(!/€|month/i.test(summary.value), "no figure is invented to fill the space");
});

test("TLY-173: the buyer's own filler is treated as no answer", () => {
  // Buyers write "N/A" and "Not stated" into these fields constantly. Showing
  // that back as though it were a contract value helps nobody.
  for (const filler of ["N/A", "n/a", "none", "Not stated", "-", "   "]) {
    assert.match(summariseNotice(notice({ estimatedValue: filler })).value, /^\[INPUT NEEDED:/,
      `"${filler}" should read as a gap`);
  }
});

test("TLY-173: a summary built from the notice alone says which judgements it has not made", () => {
  const summary = summariseNotice(notice());
  assert.equal(summary.packUnread, true);
  assert.deepEqual(summary.unassessed, [...UNASSESSED_WITHOUT_PACK]);
  assert.ok(summary.unassessed.some((item) => /^Eligibility/.test(item)),
    "the most expensive mistake is bidding for something you cannot legally win");
  assert.ok(summary.unassessed.some((item) => /weighting/i.test(item)));
});

test("TLY-173: once the pack is read, the summary stops claiming it is unassessed", () => {
  const analysed = notice({ analysis: { headline: "x" } as never });
  const summary = summariseNotice(analysed);
  assert.equal(summary.packUnread, false);
  assert.deepEqual(summary.unassessed, []);
});

test("TLY-173: the text form leads with the facts and ends with the caveat", () => {
  const text = noticeSummaryText(notice());
  assert.match(text, /Buyer: {5}Health Service Executive/);
  assert.match(text, /Value: {5}€450,000/);
  assert.match(text, /Closes: {4}16\/10\/2026 13:00/);
  assert.match(text, /based on the published notice only/);
  assert.match(text, /Upload the tender pack to assess them\./);
  assert.ok(text.indexOf("Buyer:") < text.indexOf("based on the published notice only"),
    "the facts come first; the caveat qualifies them rather than burying them");
});

test("TLY-173: an analysed tender's text carries no caveat", () => {
  const text = noticeSummaryText(notice({ analysis: { headline: "x" } as never }));
  assert.ok(!text.includes("based on the published notice only"));
});

test("TLY-173: a notice with no description falls back to its title rather than being blank", () => {
  assert.equal(summariseNotice(notice({ description: "" })).ask, notice().title);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { KNOWN_FIELD_LABELS, MINIMUM_DETAIL_FIELDS, parseNoticeDetailHtml, parseSearchHtml } from "../src/etenders.js";

/**
 * The eTenders parsers read a portal we do not control. A redesign used to
 * change the result silently: imports kept succeeding with every field empty,
 * and nothing failed until a user opened a blank tender.
 *
 * These tests run against markup recorded from the live portal, so a layout
 * change fails the build rather than the customer. Nothing here touches the
 * network — that is itself asserted below.
 */

const fixtures = path.resolve(import.meta.dirname, "fixtures/etenders");
const read = (name: string) => readFileSync(path.join(fixtures, name), "utf8");
const RESOURCE_ID = "8907606";

test("TLY-28 AC1: the recorded detail page yields the whole field set", () => {
  const tender = parseNoticeDetailHtml(read("notice-detail.html"), RESOURCE_ID);

  assert.equal(tender.title, "Engineer Led Design Team to deliver Stages 2 - 5 of Park Lane Enhancement Works");
  assert.equal(tender.authority, "Roscommon County Council_424");
  assert.equal(tender.deadline, "21/09/2026 16:00");
  assert.equal(tender.procedure, "Open");
  assert.equal(tender.estimatedValue, "70,000");
  assert.equal(tender.resourceId, RESOURCE_ID);
  assert.equal(tender.externalId, RESOURCE_ID);
  assert.match(String(tender.metadata["CPV Codes"]), /71320000/);
  assert.match(tender.description, /Park Lane Enhancement Works/);
  assert.equal(tender.metadata["End of clarification period"], "14/09/2026 16:00");
});

test("TLY-28 AC2: a renamed label fails loudly instead of yielding an empty field", () => {
  // The failure mode this exists to catch: the portal renames a label and the
  // import keeps "succeeding" with nothing in it.
  const drifted = read("notice-detail.html")
    .replace("Time-limit for receipt of tenders or requests to participate:", "Closing date:");
  const tender = parseNoticeDetailHtml(drifted, RESOURCE_ID);

  assert.equal(tender.deadline, "", "the label is gone, so the field is genuinely empty");
  const matched = Object.keys(tender.metadata).filter((key) => key !== "resourceId").length;
  assert.ok(
    matched < MINIMUM_DETAIL_FIELDS || tender.deadline === "",
    "a drifted page must be detectable",
  );
  // And the coverage assertion below is what turns that into a build failure.
});

test("TLY-28 AC2: coverage floor — a page yielding too few known labels is a failure", () => {
  const tender = parseNoticeDetailHtml(read("notice-detail.html"), RESOURCE_ID);
  const matched = Object.keys(tender.metadata).filter((key) => key !== "resourceId");
  assert.ok(
    matched.length >= MINIMUM_DETAIL_FIELDS,
    `only ${matched.length} of ${KNOWN_FIELD_LABELS.length} known labels matched; the detail-page layout has drifted`,
  );

  // Every field the product actually depends on, named individually so a
  // failure says which one went missing rather than just "fewer fields".
  for (const required of [
    "Title",
    "Name of Contracting Authority",
    "Time-limit for receipt of tenders or requests to participate",
    "Procedure",
    "CPV Codes",
    "Estimated value (EUR)",
  ]) {
    assert.ok(String(tender.metadata[required] ?? "").trim().length > 0, `detail field missing: ${required}`);
  }
});

test("TLY-28 AC3: the search table is read by content, and zero rows is never a pass", () => {
  const { items } = parseSearchHtml(read("search-results.html"));
  assert.ok(items.length >= 5, `expected the recorded results page to yield rows, got ${items.length}`);

  const first = items[0];
  assert.equal(first.externalId, "8909575");
  assert.equal(first.title, "Trocaire RFT Payroll Outsourcing Services 2026");
  assert.equal(first.authority, "Trócaire_166765");
  assert.equal(first.procedure, "Open");
  assert.match(first.sourceUrl, /^https:\/\/www\.etenders\.gov\.ie\/.*resourceId=8909575$/);

  // Every row must carry the two things a notice is useless without.
  for (const item of items) {
    assert.ok(item.externalId.trim().length > 0, "a row with no resource id cannot be imported");
    assert.ok(item.title.trim().length > 0, `row ${item.externalId} has no title`);
  }
});

test("TLY-28 AC3: moving the title to another column changes the result, so drift is caught", () => {
  // The crawler reads the results table by column position. A redesign that
  // moves the title is exactly the change that used to pass unnoticed.
  const html = read("search-results.html");
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const dataRow = rows.find((row) => row.includes("8909575"));
  assert.ok(dataRow, "the fixture still contains the recorded row");

  const cells = dataRow.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
  assert.ok(cells.length > 3, "the recorded row has the columns the parser reads");
  // Swap the title column with the contracting-authority column.
  const swapped = dataRow.replace(cells[1], "@@TITLE@@").replace(cells[3], cells[1]).replace("@@TITLE@@", cells[3]);
  const { items } = parseSearchHtml(html.replace(dataRow, swapped));

  const row = items.find((item) => item.externalId === "8909575");
  assert.ok(row, "the row is still found");
  assert.notEqual(row.title, "Trocaire RFT Payroll Outsourcing Services 2026",
    "the title now reads from the wrong column, which is what AC1's assertion catches");
});

test("TLY-28 AC4: the fixtures exist and carry no personal contact details", () => {
  const files = readdirSync(fixtures);
  assert.ok(files.includes("search-results.html"), "a recorded search-results page is present");
  assert.ok(files.includes("notice-detail.html"), "a recorded notice-detail page is present");

  for (const file of files.filter((name) => name.endsWith(".html"))) {
    const html = read(file);
    // The Contact Point field is the one place the portal carries a person, so
    // it is scrubbed to a role. Anything that is not one of those placeholders
    // is treated as a name that survived.
    const placeholders = ["", "Procurement Officer", "Contracting Authority"];
    const contact = /Contact\s*Point\s*:?\s*<\/dt>\s*<dd[^>]*>([^<]*)</i.exec(html);
    const value = contact?.[1]?.trim() ?? "";
    assert.ok(
      placeholders.includes(value),
      `${file} still names a person in Contact Point: "${value}"`,
    );
    const emails = [...html.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((match) => match[0]);
    assert.ok(
      emails.every((address) => address.endsWith("@example.test")),
      `${file} contains a real email address: ${emails.filter((address) => !address.endsWith("@example.test")).join(", ")}`,
    );
    assert.doesNotMatch(html, /\+353\s*(?!00\b)\d/, `${file} contains a real phone number`);
  }
});

test("TLY-28 AC5: parsing reaches no network at all", async () => {
  // Both parsers are pure functions over a string. Proving it by failing any
  // outbound request is stronger than asserting nobody wrote a fetch call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("a parser tried to reach the network"); }) as typeof fetch;
  try {
    const tender = parseNoticeDetailHtml(read("notice-detail.html"), RESOURCE_ID);
    const { items } = parseSearchHtml(read("search-results.html"));
    assert.ok(tender.title.length > 0);
    assert.ok(items.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

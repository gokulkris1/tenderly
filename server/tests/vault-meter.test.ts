import assert from "node:assert/strict";
import test from "node:test";
import { isExpired, STANDARD_KINDS, vaultCompleteness } from "../src/vault.js";
import type { EvidenceRecord } from "../src/types.js";

const item = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
  id: Math.random().toString(36).slice(2), accountId: "a", kind: "Document",
  name: "A document", content: "", tags: [], verified: true, ...over,
});

const NOW = new Date(Date.UTC(2026, 7, 24));

/** One in-date, verified item for each of the named kinds. */
const holding = (labels: string[]) => labels.map((label) => item({ kind: label, name: `${label} 2026`, expiresOn: "31/12/2027" }));

test("TLY-55 AC1: a partial vault reads as a fraction and names what is missing", () => {
  const result = vaultCompleteness(holding([
    "Tax clearance", "Public liability", "Professional indemnity", "Health and safety",
  ]), new Date(NOW));

  assert.equal(result.complete, 4);
  assert.equal(result.total, 9);
  assert.equal(result.missing.length, 5);
  assert.ok(result.missing.includes("Employers liability insurance"));
  assert.ok(result.missing.includes("ESPD declarations"));
  assert.ok(!result.missing.includes("Tax clearance certificate"), "what you hold is not listed as missing");
});

test("TLY-55 AC2: adding the missing kind moves the number", () => {
  const before = vaultCompleteness(holding(["Tax clearance", "Public liability", "Professional indemnity", "Health and safety"]), new Date(NOW));
  const after = vaultCompleteness(holding([
    "Tax clearance", "Public liability", "Professional indemnity", "Health and safety", "Employers liability",
  ]), new Date(NOW));
  assert.equal(before.complete, 4);
  assert.equal(after.complete, 5);
  assert.ok(!after.missing.includes("Employers liability insurance"));
});

test("TLY-55 AC3: an expired certificate is listed as expired and does not count", () => {
  const result = vaultCompleteness([
    item({ kind: "Tax clearance", name: "Tax clearance 2024", expiresOn: "31/12/2024" }),
  ], new Date(NOW));

  assert.equal(result.complete, 0);
  assert.ok(result.expired.includes("Tax clearance certificate"));
  assert.ok(!result.missing.includes("Tax clearance certificate"), "you have it; it has lapsed, which is a different job");
});

test("TLY-55 AC4: an unverified item is awaiting verification and does not count", () => {
  const result = vaultCompleteness([
    item({ kind: "Public liability", name: "Public liability 2026", expiresOn: "31/12/2027", verified: false }),
  ], new Date(NOW));

  assert.equal(result.complete, 0);
  assert.ok(result.awaitingVerification.includes("Public liability insurance"));
  assert.deepEqual(result.expired, []);
});

test("TLY-55 AC5: a full vault reads nine of nine", () => {
  const result = vaultCompleteness(holding([
    "Tax clearance", "Employers liability", "Public liability", "Professional indemnity",
    "Financial statements", "Health and safety", "ISO 9001", "Insurance schedule", "ESPD",
  ]), new Date(NOW));

  assert.equal(result.complete, 9);
  assert.equal(result.complete, result.total);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.expired, []);
  assert.deepEqual(result.awaitingVerification, []);
});

test("TLY-55: a current copy is not masked by a lapsed one of the same kind", () => {
  const result = vaultCompleteness([
    item({ kind: "Tax clearance", name: "Tax clearance 2024", expiresOn: "31/12/2024" }),
    item({ kind: "Tax clearance", name: "Tax clearance 2026", expiresOn: "31/12/2027" }),
  ], new Date(NOW));

  assert.equal(result.complete, 1, "holding an old copy as well is not a problem");
  assert.equal(result.kinds.find((kind) => kind.id === "tax-clearance")?.itemName, "Tax clearance 2026");
});

test("TLY-55: an unknown or unreadable expiry is not treated as expired", () => {
  assert.equal(isExpired(undefined), false, "no expiry recorded is not the same as lapsed");
  assert.equal(isExpired(""), false);
  assert.equal(isExpired("whenever"), false, "inventing an expiry would condemn a good certificate");
  assert.equal(isExpired("31/12/2024", new Date(NOW)), true);
  assert.equal(isExpired("2024-12-31", new Date(NOW)), true, "either date spelling");
  assert.equal(isExpired("31/12/2027", new Date(NOW)), false);
});

test("TLY-55: the standard list is the nine kinds Irish tenders ask for", () => {
  assert.equal(STANDARD_KINDS.length, 9);
  const ids = STANDARD_KINDS.map((kind) => kind.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate kinds");
  for (const kind of STANDARD_KINDS) {
    assert.ok(kind.match.length > 0, `${kind.id} has nothing to match on`);
    assert.ok(kind.label.length > 0);
  }
});

test("TLY-55: an empty vault is zero of nine, not an error", () => {
  const result = vaultCompleteness([], new Date(NOW));
  assert.equal(result.complete, 0);
  assert.equal(result.missing.length, 9);
});

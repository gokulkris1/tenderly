import assert from "node:assert/strict";
import test from "node:test";
import { valueBand } from "./TenderTracker.js";
import type { Tender } from "@tenderly/shared";

test("value bands include exactly EUR 200k in the lower band and keep unknown separate", () => {
  const record: Tender = { id: "test", resourceId: "12345", title: "Test", authority: "Buyer", category: "", procedure: "Open", deadline: "", value: "", match: 0, decision: "REVIEW", access: "", summary: "", sourceUrl: "", published: "", framework: "", gates: [], questions: [] };
  for (const [amount, expected] of [[199999.99, "under"], [200000, "under"], [200000.01, "over"], [0, "under"], [null, "unknown"]] as const) {
    assert.equal(valueBand({ ...record, valueAmount: amount }), expected);
  }
  assert.equal(valueBand({ ...record, value: "EUR 1,200,000.00" }), "over");
  assert.equal(valueBand({ ...record, value: "Not stated" }), "unknown");
});

import assert from "node:assert/strict";
import test from "node:test";

// TEMPORARY — proves ci-pr blocks a merge (TLY-101 AC2). Deleted immediately after.
test("TLY-101 AC2: deliberately failing test to prove the gate holds", () => {
  assert.equal(1, 2, "this failure is intentional");
});

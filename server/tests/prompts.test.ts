import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_PROMPT, ANALYSIS_PROMPT_VERSION, DRAFTING_PROMPT, DRAFTING_PROMPT_VERSION } from "../src/prompts/index.js";

/**
 * These assertions exist so the product's two rules cannot be deleted quietly.
 * A prompt is not decoration: remove the REVIEW-not-FAIL clause and every
 * unevidenced requirement silently becomes a green tick.
 */

test("TLY-65 AC1: each prompt file exports a non-empty version", () => {
  assert.match(ANALYSIS_PROMPT_VERSION, /^analysis-/);
  assert.match(DRAFTING_PROMPT_VERSION, /^drafting-/);
  assert.ok(ANALYSIS_PROMPT.length > 500, "analysis prompt should not be a stub");
  assert.ok(DRAFTING_PROMPT.length > 300, "drafting prompt should not be a stub");
});

test("TLY-65 AC3: the analysis prompt keeps REVIEW rather than FAIL for missing evidence", () => {
  assert.match(
    ANALYSIS_PROMPT,
    /A missing bidder fact is REVIEW, not FAIL/i,
    "the REVIEW-not-FAIL clause is gone — missing evidence would become a pass or a fail",
  );
  assert.match(
    ANALYSIS_PROMPT,
    /status must be REVIEW/i,
    "the clause requiring REVIEW for absent or ambiguous sources is gone",
  );
});

test("TLY-65 AC3: the analysis prompt keeps the never-invent rule and the source-quote rule", () => {
  assert.match(ANALYSIS_PROMPT, /Never invent a requirement/i, "the never-invent clause is gone");
  assert.match(ANALYSIS_PROMPT, /must include a short exact quote/i, "the source-quote clause is gone");
});

test("TLY-65 AC3: the analysis prompt keeps the framework-is-not-closed rule", () => {
  // A framework establishment competition can be open; conflating the two wrongly
  // tells a bidder they are ineligible.
  assert.match(ANALYSIS_PROMPT, /Do NOT equate the word "framework" with a closed competition/i);
});

test("TLY-65 AC4: the drafting prompt keeps the [INPUT NEEDED] instruction", () => {
  assert.match(
    DRAFTING_PROMPT,
    /\[INPUT NEEDED: \.\.\.\] placeholders/i,
    "the [INPUT NEEDED] clause is gone — unknown facts would be written as if known",
  );
});

test("TLY-65 AC4: the drafting prompt keeps the never-fabricate rule", () => {
  assert.match(DRAFTING_PROMPT, /Never fabricate client names, metrics, accreditations/i);
  assert.match(DRAFTING_PROMPT, /evidenceUsed must name only supplied items actually used/i);
});

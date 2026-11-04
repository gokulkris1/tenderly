import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_PROMPT, ANALYSIS_PROMPT_VERSION, DRAFTING_PROMPT, DRAFTING_PROMPT_VERSION, REFINE_PROMPT, REFINE_PROMPT_VERSION } from "../src/prompts/index.js";

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
  // The citation rule was tightened by TLY-58 — evidenceUsed must now name only
  // items from approvedEvidence — but the constraint it enforces is the same:
  // the model may cite only what it was actually given.
  assert.match(DRAFTING_PROMPT, /evidenceUsed must name only supplied approvedEvidence items actually used/i);
  assert.match(DRAFTING_PROMPT, /evidenceHeldButUnusable must NOT be cited/i);
});

test("Biddy: the drafting prompt is Biddy, writing in the bidder's voice", () => {
  assert.match(DRAFTING_PROMPT, /You are Biddy/, "the assistant's name anchors the policy");
  assert.match(DRAFTING_PROMPT, /bidder's voice/i);
  assert.match(DRAFTING_PROMPT, /first person plural/i);
  assert.match(DRAFTING_PROMPT, /never mention Biddy, AI or drafting tools in the answer/i,
    "drafts must read as the bidder's own words, without concealing provenance from the bidder");
});

test("Biddy: the drafting prompt answers every sub-question, with evidenced specifics for buyer outcomes", () => {
  assert.match(DRAFTING_PROMPT, /sub-questions/i);
  assert.match(DRAFTING_PROMPT, /address each one directly and in the order asked/i);
  assert.match(DRAFTING_PROMPT, /specific, evidenced example over three generic claims/i);
  assert.match(DRAFTING_PROMPT, /buyer's outcomes/i);
  assert.match(DRAFTING_PROMPT, /Promise only achievable delivery/i);
  assert.match(DRAFTING_PROMPT, /No boilerplate, filler or marketing slogans/i);
});

test("Biddy: the drafting prompt never marks its own work ready and respects the pack's AI policy", () => {
  assert.match(DRAFTING_PROMPT, /Never mark your own work ready/i);
  assert.match(DRAFTING_PROMPT, /AI USE POLICY/);
  assert.match(DRAFTING_PROMPT, /disclosure is required/i);
  assert.match(DRAFTING_PROMPT, /never conceal that a draft was model-written/i);
});

test("Biddy: an AI-disclosure question is answered honestly, never silenced by the no-AI-mention rule", () => {
  assert.match(DRAFTING_PROMPT, /asks about the bidder's use of AI/i,
    "the drafting prompt must carve out disclosure questions from the no-AI-mention rule");
  assert.match(DRAFTING_PROMPT, /Never conceal AI assistance/i);
  assert.match(REFINE_PROMPT, /keep the disclosure honest and complete/i,
    "a revision must not edit an AI-use declaration into silence");
  assert.match(REFINE_PROMPT, /concealing AI assistance/i);
});

test("Biddy: the refine prompt is the same policy applied to revision", () => {
  assert.match(REFINE_PROMPT_VERSION, /^refine-/);
  assert.match(REFINE_PROMPT, /You are Biddy/);
  assert.match(REFINE_PROMPT, /bidder's voice/i);
  assert.match(REFINE_PROMPT, /must not drop a sub-question/i);
  assert.match(REFINE_PROMPT, /cut boilerplate, filler and slogans/i);
  assert.match(REFINE_PROMPT, /buyer's outcomes/i);
  assert.match(REFINE_PROMPT, /Readiness is a human's decision, never the editor's/i);
  assert.match(REFINE_PROMPT, /AI-use declaration/i);
});

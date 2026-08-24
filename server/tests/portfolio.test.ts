import assert from "node:assert/strict";
import test from "node:test";
import { buildPortfolio } from "../src/portfolio.js";
import type { BidDecision } from "../src/types.js";

const NOW = new Date(Date.UTC(2026, 7, 24));

const inDays = (days: number) => {
  const date = new Date(NOW.getTime() + days * 86_400_000);
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
};

const row = (over: Partial<Parameters<typeof buildPortfolio>[0][number]> = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  title: "A tender",
  authority: "Authority",
  deadline: inDays(30),
  recommendation: "REVIEW" as BidDecision,
  unresolvedBlockers: 0,
  estimatedValue: "100,000.00",
  ...over,
});

test("TLY-51 AC1: every live tender carries what a manager triages on", () => {
  const { live } = buildPortfolio([
    row({ id: "a", title: "Alpha", recommendation: "GO", unresolvedBlockers: 2, decision: "BID" }),
    row({ id: "b", title: "Bravo" }),
    row({ id: "c", title: "Charlie" }),
    row({ id: "d", title: "Delta" }),
    row({ id: "e", title: "Echo" }),
  ], { now: new Date(NOW) });

  assert.equal(live.length, 5);
  const alpha = live.find((entry) => entry.id === "a")!;
  assert.equal(alpha.recommendation, "GO");
  assert.equal(alpha.decision, "BID");
  assert.equal(alpha.unresolvedBlockers, 2);
  assert.ok(alpha.daysRemaining !== null && alpha.daysRemaining > 0);
});

test("TLY-51 AC2: sorting by deadline puts the nearest first", () => {
  const { live } = buildPortfolio([
    row({ id: "far", title: "Far", deadline: inDays(40) }),
    row({ id: "near", title: "Near", deadline: inDays(3) }),
    row({ id: "mid", title: "Mid", deadline: inDays(12) }),
  ], { sort: "deadline", now: new Date(NOW) });

  assert.deepEqual(live.map((entry) => entry.id), ["near", "mid", "far"]);
});

test("TLY-51: a tender with no readable deadline sorts last rather than leading the board", () => {
  const { live } = buildPortfolio([
    row({ id: "unknown", title: "Unknown", deadline: "Verify deadline" }),
    row({ id: "near", title: "Near", deadline: inDays(5) }),
  ], { sort: "deadline", now: new Date(NOW) });

  assert.deepEqual(live.map((entry) => entry.id), ["near", "unknown"]);
  assert.equal(live[1].daysRemaining, null, "and it shows no day count rather than a guess");
});

test("TLY-51: the other sorts triage by recommendation and by open work", () => {
  const rows = [
    row({ id: "review", recommendation: "REVIEW", unresolvedBlockers: 1 }),
    row({ id: "go", recommendation: "GO", unresolvedBlockers: 7 }),
    row({ id: "nogo", recommendation: "NO_GO", unresolvedBlockers: 3 }),
  ];
  assert.deepEqual(
    buildPortfolio(rows, { sort: "recommendation", now: new Date(NOW) }).live.map((entry) => entry.id),
    ["go", "review", "nogo"],
  );
  assert.deepEqual(
    buildPortfolio(rows, { sort: "blockers", now: new Date(NOW) }).live.map((entry) => entry.id),
    ["go", "nogo", "review"],
  );
});

test("TLY-51 AC3: pipeline value totals the decided bids", () => {
  const { pipeline } = buildPortfolio([
    row({ id: "a", decision: "BID", estimatedValue: "100,000.00" }),
    row({ id: "b", decision: "BID", estimatedValue: "250,000.00" }),
    row({ id: "c", decision: "BID", estimatedValue: "400,000.00" }),
    row({ id: "d", decision: "NO_BID", estimatedValue: "90,000.00" }),
  ], { now: new Date(NOW) });

  const bid = pipeline.find((entry) => entry.decision === "BID")!;
  assert.equal(bid.value, 750_000);
  assert.equal(bid.count, 3);
  assert.equal(pipeline.find((entry) => entry.decision === "NO_BID")?.value, 90_000);
});

test("TLY-51: an undecided tender is not yet pipeline, and an unstated value adds nothing", () => {
  const { pipeline } = buildPortfolio([
    row({ id: "a", decision: "BID", estimatedValue: "100,000.00" }),
    row({ id: "b", estimatedValue: "500,000.00" }),
    row({ id: "c", decision: "BID", estimatedValue: "Not stated" }),
  ], { now: new Date(NOW) });

  const bid = pipeline.find((entry) => entry.decision === "BID")!;
  assert.equal(bid.count, 2, "both decided tenders are counted");
  assert.equal(bid.value, 100_000, "but a value the pack never stated contributes nothing rather than a guess");
});

test("TLY-51 AC4: a passed deadline that was never submitted is closed, not live", () => {
  const { live, closed } = buildPortfolio([
    row({ id: "past", title: "Past", deadline: inDays(-5) }),
    row({ id: "current", title: "Current", deadline: inDays(10) }),
  ], { now: new Date(NOW) });

  assert.deepEqual(live.map((entry) => entry.id), ["current"]);
  assert.deepEqual(closed.map((entry) => entry.id), ["past"]);
  assert.equal(closed[0].daysRemaining, null, "a negative day count would be nonsense on screen");
});

test("TLY-51: a submitted tender stays live even past its deadline", () => {
  const { live, closed } = buildPortfolio([
    row({ id: "submitted", title: "Submitted", deadline: inDays(-5) }),
  ], { submittedIds: ["submitted"], now: new Date(NOW) });

  assert.equal(live.length, 1, "it was submitted; it is not a missed opportunity");
  assert.equal(closed.length, 0);
});

test("TLY-51 AC5: an empty account says so rather than drawing an empty board", () => {
  const portfolio = buildPortfolio([], { now: new Date(NOW) });
  assert.equal(portfolio.note, "No live opportunities");
  assert.deepEqual(portfolio.live, []);
  assert.deepEqual(portfolio.pipeline, []);
});

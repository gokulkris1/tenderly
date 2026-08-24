import { parseContractValue } from "./scoring.js";
import { parseDeadline } from "./pressure.js";
import type { BidDecision } from "./types.js";

/**
 * The pipeline on one board.
 *
 * Bid decisions are made one tender at a time, but capacity is finite across
 * the week. This adds no scoring of its own — every number here is already
 * computed somewhere else and is only being gathered.
 */

export type PortfolioRow = {
  id: string;
  title: string;
  authority: string;
  deadline: string;
  /** Null when the deadline could not be read; negative is never shown. */
  daysRemaining: number | null;
  recommendation: BidDecision;
  /** The company's own decision, when one has been recorded. */
  decision?: "BID" | "NO_BID";
  unresolvedBlockers: number;
  estimatedValue: string;
  /** Deadline passed and never submitted. */
  closed: boolean;
};

export type PipelineValue = { decision: string; count: number; value: number };

export type Portfolio = {
  live: PortfolioRow[];
  closed: PortfolioRow[];
  /** Total estimated value by recorded decision, for the summary bar. */
  pipeline: PipelineValue[];
  note?: string;
};

export type PortfolioSort = "deadline" | "recommendation" | "blockers";

/** Go first, then Partner, then Review, then No-Go: the triage order. */
const DECISION_ORDER: Record<BidDecision, number> = { GO: 0, PARTNER: 1, REVIEW: 2, NO_GO: 3 };

/**
 * Builds the board.
 *
 * A tender whose deadline has passed without being submitted is closed: it is
 * still the company's record, but it is not something to triage this week.
 */
export function buildPortfolio(rows: Omit<PortfolioRow, "daysRemaining" | "closed">[], args: {
  sort?: PortfolioSort;
  submittedIds?: string[];
  now?: Date;
} = {}): Portfolio {
  const now = args.now ?? new Date();
  const submitted = new Set(args.submittedIds ?? []);

  const enriched: PortfolioRow[] = rows.map((row) => {
    const deadline = parseDeadline(row.deadline);
    const days = deadline ? Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000) : null;
    return {
      ...row,
      daysRemaining: days !== null && days >= 0 ? days : null,
      closed: days !== null && days < 0 && !submitted.has(row.id),
    };
  });

  const live = enriched.filter((row) => !row.closed);
  const closed = enriched.filter((row) => row.closed);

  const sort = args.sort ?? "deadline";
  live.sort((a, b) => {
    if (sort === "recommendation") {
      return DECISION_ORDER[a.recommendation] - DECISION_ORDER[b.recommendation] || a.title.localeCompare(b.title);
    }
    if (sort === "blockers") return b.unresolvedBlockers - a.unresolvedBlockers || a.title.localeCompare(b.title);
    // Deadline ascending, and a tender with no readable deadline sorts last:
    // it cannot be triaged by time, so it should not lead the board.
    if (a.daysRemaining === null && b.daysRemaining === null) return a.title.localeCompare(b.title);
    if (a.daysRemaining === null) return 1;
    if (b.daysRemaining === null) return -1;
    return a.daysRemaining - b.daysRemaining || a.title.localeCompare(b.title);
  });

  // Pipeline value counts only what the company decided to bid or not bid.
  // A tender with no decision is not yet pipeline, and a value the pack never
  // stated contributes nothing rather than a guess.
  const byDecision = new Map<string, PipelineValue>();
  for (const row of live) {
    if (!row.decision) continue;
    const entry = byDecision.get(row.decision) ?? { decision: row.decision, count: 0, value: 0 };
    entry.count += 1;
    entry.value += parseContractValue(row.estimatedValue) ?? 0;
    byDecision.set(row.decision, entry);
  }

  return {
    live,
    closed,
    pipeline: [...byDecision.values()].sort((a, b) => b.value - a.value),
    note: enriched.length === 0 ? "No live opportunities" : undefined,
  };
}

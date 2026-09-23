import { cpvAncestors, extractCpvCode } from "./cpv.js";
import { parseDeadline } from "./pressure.js";

/**
 * What the 05:00 run puts on the board.
 *
 * Two things were conflated before and are separated here. Whether a tender is
 * relevant enough to look at is a filter; how far up the list it sits is a
 * ranking. The score was doing both, which meant a company asking for "every
 * tender under CPV 72000000" got almost nothing: real notices are tagged with
 * specific children like 72212000, that scores as an ancestor match worth 22,
 * and the ingest threshold is 45. An empty board, for a reason nobody could see.
 *
 * So a CPV family match includes a tender outright. The score then orders the
 * board rather than gating it, which is also the honest description of what a
 * relevance score is.
 */

/**
 * The profile CPV code that covers this notice, or null when none does.
 *
 * A profile code covers a notice when they are the same code or when the
 * profile code is one of the notice code's ancestors — 72000000 covers
 * 72212000, because the buyer is buying something inside the family the
 * company registered for.
 */
export function cpvFamilyMatch(noticeCpv: string | null, profileCodes: string[]): string | null {
  const notice = extractCpvCode(noticeCpv ?? "");
  if (!notice) return null;
  const ancestry = new Set([notice, ...cpvAncestors(notice).map((entry) => entry.code)]);
  for (const raw of profileCodes) {
    const code = extractCpvCode(raw);
    if (code && ancestry.has(code)) return code;
  }
  return null;
}

export type IngestVerdict = {
  ingest: boolean;
  /** Why, in words that can be shown on the board without rewriting. */
  reason: string;
  /** The profile CPV that included it, when that is what did. */
  matchedCpv?: string;
  /** True when the notice states no deadline, so nobody reads silence as "open". */
  deadlineUnknown?: boolean;
};

/**
 * Decides whether one notice becomes a tender on the board.
 *
 * Order matters. A closed tender is never ingested however well it matches —
 * a board carrying tenders that can no longer be bid is a board that gets
 * ignored. After that, a CPV family match is sufficient on its own, and the
 * score is the fallback for notices whose CPV we could not read.
 */
export function decideIngest(args: {
  deadline: string;
  noticeCpv: string | null;
  profileCpvCodes: string[];
  score: number;
  threshold: number;
  now?: Date;
}): IngestVerdict {
  const now = args.now ?? new Date();
  const deadline = parseDeadline(args.deadline);

  if (deadline && deadline.getTime() <= now.getTime()) {
    return { ingest: false, reason: `Closed: the deadline passed on ${args.deadline}` };
  }
  // No stated deadline is not evidence that it closed. It travels as a flag so
  // the board can say so rather than implying the tender is comfortably open.
  const deadlineUnknown = !deadline;

  const matchedCpv = cpvFamilyMatch(args.noticeCpv, args.profileCpvCodes);
  if (matchedCpv) {
    const notice = extractCpvCode(args.noticeCpv ?? "");
    return {
      ingest: true,
      matchedCpv,
      deadlineUnknown,
      reason: notice === matchedCpv
        ? `CPV ${notice} matches your profile`
        : `CPV ${notice} sits under your ${matchedCpv}`,
    };
  }

  if (args.score >= args.threshold) {
    return { ingest: true, deadlineUnknown, reason: `Scored ${args.score} against a threshold of ${args.threshold}` };
  }

  return {
    ingest: false,
    reason: args.noticeCpv
      ? `CPV ${args.noticeCpv} is outside your profile and it scored ${args.score}`
      : `No CPV published and it scored ${args.score}`,
  };
}

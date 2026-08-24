import type { PublicTender } from "./types.js";

/**
 * Whether a source is still yielding what it used to.
 *
 * Fixtures catch parser drift in CI, but production drift showed up only as a
 * quietly empty Discover list — nobody was told, and the job reported success.
 * This compares a run against the source's own recent history and says plainly
 * when the numbers have collapsed.
 *
 * The comparison is against the trailing median rather than a fixed number: a
 * source that normally yields 8 notices is not broken for yielding 7, and one
 * that normally yields 400 is broken long before it reaches 8.
 */

export type FieldCoverage = Record<string, number>;

export type IngestionRun = {
  id: string;
  source: string;
  noticesSeen: number;
  noticesParsed: number;
  fieldCoverage: FieldCoverage;
  alarms: string[];
  createdAt: string;
};

/** The fields a notice is close to useless without. */
export const REQUIRED_NOTICE_FIELDS = ["externalId", "title", "authority", "deadline"] as const;

/**
 * A run is degraded when a required field is empty on more than this share of
 * the notices it parsed. Set high because some sources legitimately omit a
 * deadline on a minority of notices; a collapse is what this is looking for.
 */
export const FIELD_EMPTY_THRESHOLD = 0.5;

/** Parsed notices below this multiple of the trailing median raise the alarm. */
export const YIELD_FLOOR_RATIO = 0.5;

/** How many notices carried each required field. */
export function fieldCoverage(notices: PublicTender[]): FieldCoverage {
  const coverage: FieldCoverage = {};
  for (const field of REQUIRED_NOTICE_FIELDS) {
    coverage[field] = notices.filter((notice) => String(notice[field] ?? "").trim().length > 0).length;
  }
  return coverage;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Judges one run against the source's history.
 *
 * With no history nothing is claimed: a first run cannot be below its own
 * median, and inventing an alarm about missing history would train people to
 * ignore the alarms that matter.
 */
export function assessRun(args: {
  source: string;
  noticesParsed: number;
  fieldCoverage: FieldCoverage;
  /** Parsed counts from previous runs of this source, newest first. */
  history: number[];
}): { ok: boolean; alarms: string[]; floor: number | null } {
  const alarms: string[] = [];
  const trailing = median(args.history);
  const floor = trailing === null ? null : Math.floor(trailing * YIELD_FLOOR_RATIO);

  if (floor !== null && args.noticesParsed < floor) {
    alarms.push(
      `${args.source}: parsed ${args.noticesParsed} notices, below the expected floor of ${floor} ` +
      `(half the trailing median of ${trailing})`,
    );
  }

  for (const field of REQUIRED_NOTICE_FIELDS) {
    const populated = args.fieldCoverage[field] ?? 0;
    if (args.noticesParsed === 0) break;
    const emptyShare = 1 - populated / args.noticesParsed;
    if (emptyShare > FIELD_EMPTY_THRESHOLD) {
      alarms.push(
        `${args.source}: ${field} was empty on ${Math.round(emptyShare * 100)}% of ${args.noticesParsed} parsed notices`,
      );
    }
  }

  return { ok: alarms.length === 0, alarms, floor };
}

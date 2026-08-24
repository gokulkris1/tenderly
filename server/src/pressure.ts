/**
 * How much room the bidder actually has.
 *
 * A winnable tender is still a bad bid if it closes in four days while three
 * others close the same week and the mandatory items are unresolved. This is
 * deterministic arithmetic over the account's own pipeline — no model call, so
 * it is free, reproducible and explainable.
 */

export type PressureBand = "Low" | "Medium" | "High";

export type CompetingBid = {
  id: string;
  title: string;
  deadline: string;
};

export type DeadlinePressure = {
  /** Absent when the deadline could not be read; no band is claimed either. */
  band?: PressureBand;
  workingDaysRemaining: number | null;
  unresolvedItems: number;
  competingBids: CompetingBid[];
  /** Shown when there is no deadline to reason about. */
  note?: string;
};

/** Easter Sunday by the anonymous Gregorian algorithm. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** The nth given weekday of a month, or the last when `nth` is -1. */
function weekdayOfMonth(year: number, month: number, weekday: number, nth: number) {
  if (nth === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    const shift = (last.getUTCDay() - weekday + 7) % 7;
    return new Date(Date.UTC(year, month + 1, 0 - shift));
  }
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (nth - 1) * 7));
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Irish public holidays for a year, as `YYYY-MM-DD`.
 *
 * A fixed-date holiday falling at the weekend is observed on the following
 * Monday, which is what actually removes a working day from a bidder's week.
 */
export function irishPublicHolidays(year: number): Set<string> {
  const days: Date[] = [];
  const observed = (date: Date) => {
    const day = date.getUTCDay();
    if (day === 6) return new Date(date.getTime() + 2 * 86_400_000);
    if (day === 0) return new Date(date.getTime() + 86_400_000);
    return date;
  };

  days.push(observed(new Date(Date.UTC(year, 0, 1))));                 // New Year's Day
  // St Brigid's Day: the first Monday in February, from 2023 onwards.
  if (year >= 2023) days.push(weekdayOfMonth(year, 1, 1, 1));
  days.push(observed(new Date(Date.UTC(year, 2, 17))));                // St Patrick's Day
  days.push(new Date(easterSunday(year).getTime() + 86_400_000));      // Easter Monday
  days.push(weekdayOfMonth(year, 4, 1, 1));                            // May
  days.push(weekdayOfMonth(year, 5, 1, 1));                            // June
  days.push(weekdayOfMonth(year, 7, 1, 1));                            // August
  days.push(weekdayOfMonth(year, 9, 1, -1));                           // October
  days.push(observed(new Date(Date.UTC(year, 11, 25))));               // Christmas Day
  days.push(observed(new Date(Date.UTC(year, 11, 26))));               // St Stephen's Day

  return new Set(days.map(iso));
}

/**
 * Reads a deadline in either portal's spelling. Returns null when there is
 * nothing readable — which the caller reports rather than guessing a date.
 */
export function parseDeadline(value: string | undefined | null): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const isoMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (isoMatch) return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  const irish = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(text);
  if (!irish) return null;
  const [day, month, year] = [Number(irish[1]), Number(irish[2]), Number(irish[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31/02: the roll-over would silently move the deadline.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/**
 * Working days between two dates, excluding weekends and Irish public
 * holidays. The deadline day itself counts: a tender closing tomorrow leaves
 * one day to work in, not none.
 */
export function workingDaysUntil(deadline: Date, from: Date): number {
  if (deadline < from) return 0;
  const holidays = new Set<string>();
  for (let year = from.getUTCFullYear(); year <= deadline.getUTCFullYear(); year += 1) {
    for (const day of irishPublicHolidays(year)) holidays.add(day);
  }
  let count = 0;
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(deadline.getUTCFullYear(), deadline.getUTCMonth(), deadline.getUTCDate()));
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.has(iso(cursor))) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** How many working days count as "the same week" for competing deadlines. */
const SAME_WEEK_WORKING_DAYS = 5;

/**
 * The pressure on this bid.
 *
 * The band is deliberately blunt: it exists to make a bidder pause, not to
 * carry more precision than the inputs support. An unreadable deadline produces
 * no band at all — asserting "Low" for a date we could not find would be the
 * kind of confident guess the product exists to avoid.
 */
export function deadlinePressure(args: {
  deadline: string | undefined | null;
  unresolvedItems: number;
  /** Other live bids on this account, with their own deadlines. */
  otherBids: CompetingBid[];
  now?: Date;
}): DeadlinePressure {
  const now = args.now ?? new Date();
  const deadline = parseDeadline(args.deadline);

  if (!deadline) {
    return {
      workingDaysRemaining: null,
      unresolvedItems: args.unresolvedItems,
      competingBids: [],
      note: "[INPUT NEEDED: submission deadline]",
    };
  }

  const remaining = workingDaysUntil(deadline, now);
  const competing = args.otherBids.filter((bid) => {
    const other = parseDeadline(bid.deadline);
    if (!other) return false;
    const gap = workingDaysUntil(other, now);
    return gap > 0 && Math.abs(gap - remaining) < SAME_WEEK_WORKING_DAYS;
  });

  // Time is the dominant term; unresolved work and a crowded week tighten it.
  let band: PressureBand = remaining <= 5 ? "High" : remaining <= 12 ? "Medium" : "Low";
  if (band === "Low" && (competing.length >= 2 || args.unresolvedItems >= 10)) band = "Medium";
  if (band === "Medium" && competing.length >= 2 && args.unresolvedItems >= 10) band = "High";

  return { band, workingDaysRemaining: remaining, unresolvedItems: args.unresolvedItems, competingBids: competing };
}

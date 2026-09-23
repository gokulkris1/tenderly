import type { TenderRecord } from "./types.js";

/**
 * The executive summary a director reads at 09:00 to decide yes or no.
 *
 * Built from the notice alone and from no model call at all, because the
 * eTenders detail page already states what is being bought, by whom, for how
 * much, for how long and by when — the four facts the decision turns on. Asking
 * a model to restate structured fields would cost money and introduce a chance
 * of getting them wrong.
 *
 * What it cannot do is assess eligibility, because the gates live in the tender
 * documents and TLY-168 measured those as gated behind a portal login in
 * twenty-eight of twenty-eight cases. So the summary says so. A thin summary
 * that admits its own limits is useful; one that reads complete and is not is
 * the failure this whole product exists to prevent.
 */

export type NoticeSummary = {
  /** What is being bought, in the buyer's own words. */
  ask: string;
  buyer: string;
  /** Each rendered as stated, or as an explicit gap. Never inferred. */
  value: string;
  duration: string;
  deadline: string;
  procedure: string;
  cpv: string;
  /** True while the summary rests on the notice alone. */
  packUnread: boolean;
  /** What cannot be known until the tender documents are read. */
  unassessed: string[];
};

const UNKNOWN = (what: string) => `[INPUT NEEDED: ${what}]`;

/** A field as the notice states it, or an explicit gap. Blank is not a value. */
function stated(value: unknown, what: string) {
  const text = String(value ?? "").trim();
  return text && !/^(n\/?a|none|not stated|-)$/i.test(text) ? text : UNKNOWN(what);
}

/**
 * Everything the pack decides and the notice cannot.
 *
 * Named individually rather than as "full analysis pending", because a person
 * deciding whether to spend two days on a bid needs to know that the eligibility
 * verdict is absent, not that something unspecified is.
 */
export const UNASSESSED_WITHOUT_PACK = [
  "Eligibility — the mandatory gates are stated in the tender documents",
  "Scored questions and their word limits",
  "Evaluation criteria and their weightings",
  "The submission checklist and required certificates",
] as const;

export function summariseNotice(tender: TenderRecord): NoticeSummary {
  const metadata = (tender.metadata ?? {}) as Record<string, unknown>;
  const packUnread = !tender.analysis;

  return {
    ask: String(tender.description ?? "").trim() || tender.title,
    buyer: stated(tender.authority, "contracting authority"),
    value: stated(tender.estimatedValue, "contract value not stated in the notice"),
    duration: stated(
      metadata["Contract duration in months or years, including any options and renewals"],
      "contract duration not stated in the notice",
    ),
    deadline: stated(tender.deadline, "response deadline not stated in the notice"),
    procedure: stated(tender.procedure, "procedure"),
    cpv: stated(metadata["CPV Codes"], "CPV not published"),
    packUnread,
    unassessed: packUnread ? [...UNASSESSED_WITHOUT_PACK] : [],
  };
}

/** The summary as plain text, for a digest or a screen that wants it whole. */
export function noticeSummaryText(tender: TenderRecord, summary = summariseNotice(tender)) {
  const lines = [
    tender.title,
    "",
    `Buyer:     ${summary.buyer}`,
    `Value:     ${summary.value}`,
    `Duration:  ${summary.duration}`,
    `Closes:    ${summary.deadline}`,
    `Procedure: ${summary.procedure}`,
    `CPV:       ${summary.cpv}`,
    "",
    summary.ask,
  ];
  if (summary.packUnread) {
    lines.push(
      "",
      "This summary is based on the published notice only. The tender documents",
      "have not been read, so the following are not assessed:",
      ...summary.unassessed.map((item) => `  - ${item}`),
      "",
      "Upload the tender pack to assess them.",
    );
  }
  return `${lines.join("\n")}\n`;
}

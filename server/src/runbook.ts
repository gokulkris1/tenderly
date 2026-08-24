import type { SubmissionFormality, TenderAnalysis, TenderRecord } from "./types.js";

/**
 * The last mile, written down.
 *
 * The product deliberately stops before submission, but the handover was a ZIP
 * file and good luck: the user had to work out from the pack which file goes
 * where, in what order, under what naming convention. Bids fail on formalities
 * more often than on quality, and this is where that happens.
 *
 * Nothing here automates the portal. Submission stays a human action on the
 * buyer's system, which is the point.
 */

export type RunbookStep = {
  id: string;
  text: string;
  /** The formality this step came from, quoted, when it came from one. */
  source?: string;
};

export type Runbook = {
  /** Where the response goes, as the pack states it. */
  channel: string;
  deadline: string;
  steps: RunbookStep[];
  /** True when the pack stated no formalities and the steps are generic. */
  generic: boolean;
};

export const NAMING_UNKNOWN = "[INPUT NEEDED: file naming rules]";

/** A stable id per step, so a tick survives a regenerated runbook. */
function stepId(text: string) {
  return `step-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}`;
}

const step = (text: string, source?: string): RunbookStep => ({ id: stepId(text), text, source });

/**
 * Formalities that govern how files are named or uploaded, in the pack's own
 * words. Ordered as the pack states them: a buyer who numbered their
 * requirements has told us the order.
 */
function fileFormalities(formalities: SubmissionFormality[]) {
  return formalities.filter((formality) =>
    /file|name|naming|format|upload|separate|pdf|docx|zip|label/i.test(`${formality.rule} ${formality.appliesTo}`));
}

/**
 * Builds the runbook for one tender.
 *
 * Where the pack states a rule, it is quoted. Where it states none, the step
 * says so with [INPUT NEEDED: …] rather than inventing a convention — a made-up
 * naming rule followed confidently is worse than an obvious gap.
 */
export function buildRunbook(tender: TenderRecord, analysis: TenderAnalysis | null): Runbook {
  const formalities = analysis?.formalities ?? [];
  const fileRules = fileFormalities(formalities);
  const checklist = analysis?.submissionChecklist ?? [];

  const channel = analysis?.submissionMethod?.trim()
    || String(tender.metadata["Submission method"] ?? "").trim()
    || "[INPUT NEEDED: submission channel]";
  const deadline = analysis?.deadline?.trim() || tender.deadline?.trim() || "[INPUT NEEDED: submission deadline]";

  const steps: RunbookStep[] = [];

  steps.push(step("Sign in to the buyer's portal as the registered tenderer"));
  steps.push(step(
    fileRules.length > 0
      ? "Rename each file to match the pack's naming convention"
      : `Rename each file to match the pack's naming convention — ${NAMING_UNKNOWN}`,
    fileRules[0]?.evidence.quote,
  ));

  // Each required item the pack names, in the order it names them.
  for (const item of checklist.filter((entry) => entry.required)) {
    steps.push(step(`Upload: ${item.label}`, item.source.quote));
  }
  if (checklist.filter((entry) => entry.required).length === 0) {
    steps.push(step("Upload the response document and every buyer template the pack requires"));
  }

  // Every remaining formality is its own step: bids fail on these, so none of
  // them is summarised away.
  for (const formality of formalities) {
    if (fileRules.includes(formality)) continue;
    steps.push(step(formality.rule, formality.evidence.quote));
  }

  steps.push(step("Sign every declaration the pack requires, by the person authorised to bind the company"));
  steps.push(step(`Submit before the stated deadline: ${deadline}`));
  steps.push(step("Save the portal's submission receipt and record the submission in Tenderly"));

  return {
    channel,
    deadline,
    steps,
    generic: formalities.length === 0 && checklist.length === 0,
  };
}

/** The runbook as plain text, for the file that travels inside the final ZIP. */
export function runbookText(tender: TenderRecord, runbook: Runbook) {
  const lines = [
    "TENDERLY SUBMISSION RUNBOOK",
    "",
    tender.title,
    `Channel: ${runbook.channel}`,
    `Deadline: ${runbook.deadline}`,
    "",
    "Tenderly does not submit on your behalf. These are the steps to take on the",
    "buyer's portal, in order.",
    "",
  ];
  runbook.steps.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.text}`);
    if (entry.source) lines.push(`   Pack says: "${entry.source}"`);
  });
  if (runbook.generic) {
    lines.push("", "The pack stated no submission formalities, so these steps are the general ones.");
  }
  return `${lines.join("\n")}\n`;
}

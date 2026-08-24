/**
 * The ESPD self-declarations, answered once and reused on every bid.
 *
 * Irish public tenders require the European Single Procurement Document, and
 * companies re-answer the same questions for every competition. The headings
 * follow ESPD Part III (grounds for exclusion) and Part IV (selection criteria).
 *
 * The wording here is deliberately plain rather than a verbatim copy of the
 * regulation: a bidder has to understand what they are affirming, and an
 * affirmation nobody understood is worth nothing to them or to the buyer.
 */

export type DeclarationPart = "III" | "IV";

export type Declaration = {
  id: string;
  part: DeclarationPart;
  heading: string;
  statement: string;
  /**
   * The answer that means "there is something here a buyer needs to know", and
   * which therefore cannot stand without an explanation.
   */
  answerRequiringDetail: "yes" | "no";
};

export const DECLARATIONS: Declaration[] = [
  // Part III — grounds for exclusion. A Yes is the answer that needs detail.
  {
    id: "criminal-convictions", part: "III", heading: "Convictions",
    statement: "The company, or anyone in its administrative, management or supervisory body, has been convicted of participation in a criminal organisation, corruption, fraud, terrorist offences, money laundering, child labour or human trafficking.",
    answerRequiringDetail: "yes",
  },
  {
    id: "tax-and-social-contributions", part: "III", heading: "Taxes and social contributions",
    statement: "The company has breached its obligations to pay taxes or social security contributions.",
    answerRequiringDetail: "yes",
  },
  {
    id: "insolvency", part: "III", heading: "Insolvency",
    statement: "The company is bankrupt, being wound up, in administration or subject to any analogous procedure.",
    answerRequiringDetail: "yes",
  },
  {
    id: "grave-professional-misconduct", part: "III", heading: "Professional misconduct",
    statement: "The company is guilty of grave professional misconduct.",
    answerRequiringDetail: "yes",
  },
  {
    id: "distortion-of-competition", part: "III", heading: "Distortion of competition",
    statement: "The company has entered into an agreement with other economic operators aimed at distorting competition.",
    answerRequiringDetail: "yes",
  },
  {
    id: "conflict-of-interest", part: "III", heading: "Conflicts of interest",
    statement: "There is a conflict of interest between the company and the contracting authority arising from this procurement.",
    answerRequiringDetail: "yes",
  },
  {
    id: "prior-involvement", part: "III", heading: "Prior involvement",
    statement: "The company was involved in preparing this procurement procedure.",
    answerRequiringDetail: "yes",
  },
  {
    id: "early-termination", part: "III", heading: "Early termination",
    statement: "The company has had a prior public contract terminated early, or been subject to damages or comparable sanctions.",
    answerRequiringDetail: "yes",
  },
  {
    id: "misrepresentation", part: "III", heading: "Misrepresentation",
    statement: "The company has been guilty of serious misrepresentation, withheld information, or been unable to provide required supporting documents.",
    answerRequiringDetail: "yes",
  },

  // Part IV — selection criteria. Here a No is what needs explaining.
  {
    id: "professional-register", part: "IV", heading: "Enrolment",
    statement: "The company is enrolled in the relevant professional or trade register in Ireland.",
    answerRequiringDetail: "no",
  },
  {
    id: "economic-standing", part: "IV", heading: "Economic and financial standing",
    statement: "The company can provide its turnover figures and financial statements for the last three financial years.",
    answerRequiringDetail: "no",
  },
  {
    id: "insurance-cover", part: "IV", heading: "Insurance",
    statement: "The company holds professional indemnity, public liability and employers liability insurance at commercially normal levels.",
    answerRequiringDetail: "no",
  },
  {
    id: "technical-references", part: "IV", heading: "References",
    statement: "The company can provide references for comparable contracts delivered in the last three years.",
    answerRequiringDetail: "no",
  },
  {
    id: "quality-assurance", part: "IV", heading: "Quality assurance",
    statement: "The company operates a documented quality management system.",
    answerRequiringDetail: "no",
  },
];

export type DeclarationAnswer = {
  declarationId: string;
  answer: "yes" | "no" | null;
  notes: string;
};

export type Affirmation = {
  affirmedBy: string;
  at: string;
};

/**
 * Declarations older than this prompt re-affirmation.
 *
 * Twelve months matches the period buyers typically accept an ESPD for, and a
 * declaration a company has not looked at in over a year is a statement nobody
 * has actually stood behind recently.
 */
export const AFFIRMATION_VALID_MONTHS = 12;

/** True when the set needs affirming again — or has never been affirmed. */
export function needsReaffirmation(affirmation: Affirmation | null, now = new Date()) {
  if (!affirmation) return true;
  const at = new Date(affirmation.at);
  if (Number.isNaN(at.getTime())) return true;
  const due = new Date(at);
  due.setMonth(due.getMonth() + AFFIRMATION_VALID_MONTHS);
  return due.getTime() < now.getTime();
}

/**
 * Which answers cannot be affirmed as they stand.
 *
 * An unanswered declaration blocks affirmation because affirming a blank is
 * meaningless. An answer that needs detail and has none blocks it because the
 * detail is the part a buyer actually reads — "yes, but" without the "but" is
 * worse than not answering.
 */
export function affirmationProblems(answers: DeclarationAnswer[]): { declarationId: string; problem: string }[] {
  const byId = new Map(answers.map((answer) => [answer.declarationId, answer]));
  const problems: { declarationId: string; problem: string }[] = [];

  for (const declaration of DECLARATIONS) {
    const answer = byId.get(declaration.id);
    if (!answer?.answer) {
      problems.push({ declarationId: declaration.id, problem: "This declaration has not been answered" });
      continue;
    }
    if (answer.answer === declaration.answerRequiringDetail && !answer.notes.trim()) {
      problems.push({ declarationId: declaration.id, problem: "Supporting details are required for this answer" });
    }
  }
  return problems;
}

/**
 * The affirmed declarations as citable evidence for drafting.
 *
 * Only an affirmed, in-date set is offered: an unaffirmed answer is a draft
 * opinion, and citing it in a tender response would be a claim nobody made.
 */
export function declarationEvidence(args: {
  answers: DeclarationAnswer[];
  affirmation: Affirmation | null;
  now?: Date;
}): string {
  if (!args.affirmation || needsReaffirmation(args.affirmation, args.now ?? new Date())) return "";
  const byId = new Map(args.answers.map((answer) => [answer.declarationId, answer]));
  const lines = DECLARATIONS.flatMap((declaration) => {
    const answer = byId.get(declaration.id);
    if (!answer?.answer) return [];
    const detail = answer.notes.trim() ? ` (${answer.notes.trim()})` : "";
    return [`ESPD Part ${declaration.part} — ${declaration.heading}: ${answer.answer === "yes" ? "Yes" : "No"}${detail}`];
  });
  if (lines.length === 0) return "";
  return [
    `ESPD self-declarations affirmed by ${args.affirmation.affirmedBy} on ${new Date(args.affirmation.at).toISOString().slice(0, 10)}.`,
    ...lines,
  ].join("\n");
}

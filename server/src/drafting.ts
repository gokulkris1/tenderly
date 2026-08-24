import { aiModel, draftBidAnswer, refineBidAnswer, streamBidAnswer } from "./ai.js";
import { declarationEvidence } from "./declarations.js";
import {
  getCompany, latestAffirmation, listActivePeople, listAnswers, listDeclarationAnswers, listEvidence,
  recordAnswerVersion, recordProvenance, saveAnswer,
} from "./db.js";
import { DRAFTING_PROMPT_VERSION, REFINE_PROMPT_VERSION } from "./prompts/index.js";
import type { BidAnswer, CompanyProfile, EvidenceRecord, PersonRecord, TenderAnalysis, TenderRecord } from "./types.js";

/**
 * Drafting one answer, in one place.
 *
 * Extracted in TLY-67 so that drafting a whole questionnaire and drafting a
 * single question go through exactly the same steps. Two code paths that both
 * write an answer will eventually disagree about the provenance ledger, and the
 * ledger is the thing a buyer is entitled to rely on.
 */

export type DraftContext = {
  company: CompanyProfile;
  evidence: EvidenceRecord[];
  people: PersonRecord[];
  existingAnswers: BidAnswer[];
};

/**
 * Everything a draft rests on, gathered once.
 *
 * Fetched per run rather than per question: twelve questions asking the vault
 * for the same twenty certificates is twelve times the work for the same answer.
 */
export async function draftContext(account: string, tenderId: string): Promise<DraftContext> {
  const [company, evidence, people, existingAnswers, declarationAnswers, affirmation] = await Promise.all([
    getCompany(account), listEvidence(account), listActivePeople(account), listAnswers(tenderId),
    listDeclarationAnswers(account), latestAffirmation(account),
  ]);

  // Affirmed ESPD declarations are citable evidence: a person has stood behind
  // them. An unaffirmed or stale set is not offered, because citing it in a
  // tender response would be a claim nobody actually made.
  const declarationText = declarationEvidence({ answers: declarationAnswers, affirmation });
  const withDeclarations = declarationText
    ? [...evidence, {
        id: "espd-declarations", accountId: account, kind: "ESPD self-declaration",
        name: "ESPD self-declarations", content: declarationText, tags: ["espd"], verified: true,
      } as EvidenceRecord]
    : evidence;

  return { company, evidence: withDeclarations, people, existingAnswers };
}

/**
 * Guarantees the gaps are visible in the prose.
 *
 * The prompt asks for [INPUT NEEDED: …] placeholders and the model usually
 * obliges, but "usually" is not a product rule. An answer that reports missing
 * facts and reads as complete is the exact failure the whole product exists to
 * prevent, so the markers are added here when the model left them out.
 */
export function ensureInputMarkers(answer: string, missingInputs: string[]) {
  if (missingInputs.length === 0) return answer;
  const already = new Set(
    [...answer.matchAll(/\[INPUT NEEDED:\s*([^\]]+)\]/gi)].map((match) => match[1].trim().toLowerCase()));
  const absent = missingInputs.filter((input) => !already.has(input.trim().toLowerCase()));
  if (absent.length === 0) return answer;
  const markers = absent.map((input) => `[INPUT NEEDED: ${input}]`).join("\n");
  const prose = answer.trimEnd();
  return prose ? `${prose}\n\n${markers}` : markers;
}

/** How a streamed draft is produced. Replaced in tests so no model is called. */
export type Streamer = (input: {
  tender: TenderRecord;
  company: CompanyProfile;
  question: TenderAnalysis["questions"][number];
  evidence: EvidenceRecord[];
  people: PersonRecord[];
  existingAnswers: BidAnswer[];
  onText: (answerSoFar: string) => void;
  signal?: AbortSignal;
}) => Promise<Awaited<ReturnType<typeof draftBidAnswer>>>;

/**
 * Drafts one answer, streaming it, and saves only when it completes.
 *
 * A stopped or failed stream writes nothing: the previous answer is still the
 * saved answer, because half a draft is not a draft and silently keeping one
 * would leave a person editing prose that stops mid-sentence for reasons the
 * product never explained.
 */
export async function streamAndSaveAnswer(args: {
  tender: TenderRecord;
  question: TenderAnalysis["questions"][number];
  context: DraftContext;
  actor: string;
  onText: (answerSoFar: string) => void;
  signal?: AbortSignal;
  streamer?: Streamer;
}) {
  const stream: Streamer = args.streamer ?? streamBidAnswer;
  const draft = await stream({
    tender: args.tender, company: args.context.company, question: args.question,
    evidence: args.context.evidence, people: args.context.people,
    existingAnswers: args.context.existingAnswers, onText: args.onText, signal: args.signal,
  });

  // Checked after the stream and before the write: an aborted request must not
  // land an answer just because the last fragment arrived first.
  if (args.signal?.aborted) throw new Error("STOPPED");

  return persistDraft({ tender: args.tender, question: args.question, draft, actor: args.actor });
}

/** The [INPUT NEEDED: …] subjects named in a piece of prose. */
export function markersIn(text: string) {
  return [...text.matchAll(/\[INPUT NEEDED:\s*([^\]]+)\]/gi)].map((match) => match[1].trim());
}

/**
 * Carries every gap in the old answer into the new one.
 *
 * A refinement cannot close a gap, because refining supplies no evidence — only
 * the bidder uploading the missing document can do that. So a marker present
 * before a refinement is present after it, whatever the steering instruction
 * asked for. This is what stops "remove the placeholder and say our turnover is
 * ten million" from working.
 */
export function preserveMarkers(previous: string, revised: string) {
  const kept = new Set(markersIn(revised).map((marker) => marker.toLowerCase()));
  const lost = markersIn(previous).filter((marker) => !kept.has(marker.toLowerCase()));
  return lost.length === 0 ? revised : ensureInputMarkers(revised, lost);
}

/** How a refinement is produced. Replaced in tests so no model is called. */
export type Refiner = typeof refineBidAnswer;

/**
 * Revises an answer according to an instruction the bidder wrote, and saves it.
 *
 * The steering instruction is recorded with the version, because "shorten to
 * 150 words" is why this version differs from the one before it.
 */
export async function refineAndSaveAnswer(args: {
  tender: TenderRecord;
  question: TenderAnalysis["questions"][number];
  answer: BidAnswer;
  steering: string;
  context: DraftContext;
  actor: string;
  refiner?: Refiner;
}) {
  const refine: Refiner = args.refiner ?? refineBidAnswer;
  const revision = await refine({
    tender: args.tender, company: args.context.company, question: args.question,
    answer: args.answer.response, steering: args.steering,
    evidence: args.context.evidence, people: args.context.people,
  });

  // Two guarantees the model is not trusted to keep: gaps the bidder has not
  // filled stay visible, and gaps the revision itself found are added.
  const withOwnGaps = ensureInputMarkers(revision.answer, revision.missingInputs);
  const answer = preserveMarkers(args.answer.response, withOwnGaps);
  const status = markersIn(answer).length ? "needs-input" : "draft";

  const saved = await saveAnswer(
    args.tender.id, args.question.id, answer, status,
    (revision.citations ?? []).map((citation) => citation.id),
  );
  await recordProvenance({
    answerId: saved.id, section: "body", class: "ai-generated",
    model: aiModel(), promptVersion: REFINE_PROMPT_VERSION,
    evidenceIds: revision.evidenceUsed, actor: args.actor,
  });
  await recordAnswerVersion({
    answerId: saved.id, response: saved.response, status: saved.status,
    provenanceClass: "ai-generated", actor: args.actor, steering: args.steering,
  });

  return { revision: { ...revision, answer }, saved };
}

export type DraftOutcome = {
  questionId: string;
  title: string;
  status: BidAnswer["status"];
  answerId: string;
  citations: { id: string; name: string; hasFile: boolean }[];
  missingInputs: string[];
};

/**
 * Drafts one scored question and records it, ledger and all.
 *
 * Every path that writes an answer also records who or what wrote it and the
 * version it wrote, so no saved state is lost and no generated text loses its
 * label along the way.
 */
export async function draftAndSaveAnswer(args: {
  tender: TenderRecord;
  question: TenderAnalysis["questions"][number];
  context: DraftContext;
  actor: string;
}) {
  const draft = await draftBidAnswer({
    tender: args.tender, company: args.context.company, question: args.question,
    evidence: args.context.evidence, people: args.context.people, existingAnswers: args.context.existingAnswers,
  });

  return persistDraft({ tender: args.tender, question: args.question, draft, actor: args.actor });
}

/**
 * Writes one drafted answer and its ledger entries.
 *
 * Shared by the streamed and non-streamed paths so that a streamed draft is
 * recorded exactly as a non-streamed one is — same status rule, same markers,
 * same provenance, same version.
 */
async function persistDraft(args: {
  tender: TenderRecord;
  question: TenderAnalysis["questions"][number];
  draft: Awaited<ReturnType<typeof draftBidAnswer>>;
  actor: string;
}) {
  const { draft } = args;
  const answer = ensureInputMarkers(draft.answer, draft.missingInputs);
  const status = draft.missingInputs.length ? "needs-input" : "draft";
  // The citation stores the vault item's identifier, not just its name, so the
  // UI can open the document a buyer could be shown.
  const saved = await saveAnswer(
    args.tender.id, args.question.id, answer, status,
    (draft.citations ?? []).map((citation) => citation.id),
  );

  await recordProvenance({
    answerId: saved.id, section: "body", class: "ai-generated",
    model: aiModel(), promptVersion: DRAFTING_PROMPT_VERSION,
    evidenceIds: draft.evidenceUsed, actor: args.actor,
  });
  await recordAnswerVersion({
    answerId: saved.id, response: saved.response, status: saved.status,
    provenanceClass: "ai-generated", actor: args.actor,
  });

  const outcome: DraftOutcome = {
    questionId: args.question.id,
    title: args.question.title,
    status: saved.status,
    answerId: saved.id,
    citations: draft.citations ?? [],
    missingInputs: draft.missingInputs,
  };
  return { draft: { ...draft, answer }, saved, outcome };
}

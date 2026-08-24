import { log } from "./logging.js";
import { draftAndSaveAnswer, draftContext, type DraftOutcome } from "./drafting.js";
import type { BidAnswer, TenderAnalysis, TenderRecord } from "./types.js";

/**
 * Drafting a whole questionnaire.
 *
 * Twelve model calls do not fit inside one HTTP request, and a company should
 * not sit on a spinner for four minutes wondering whether anything is
 * happening. So the run is started, the request returns immediately, and the
 * Respond stage asks how far along it is.
 *
 * Two rules shape the rest. A question a person has marked ready is never
 * overwritten — their judgement outranks the model's. And one failed question
 * loses one question: the other eleven are saved, and the failure is named.
 */

/** How many questions are drafted at once. */
const CONCURRENCY = 3;

export type BatchQuestionState = {
  questionId: string;
  title: string;
  state: "pending" | "drafting" | "drafted" | "needs-input" | "skipped" | "failed";
  /** Why it failed, in words a person can act on. Empty otherwise. */
  error?: string;
  citations?: { id: string; name: string; hasFile: boolean }[];
};

export type BatchRun = {
  id: string;
  tenderId: string;
  startedAt: string;
  finishedAt?: string;
  total: number;
  completed: number;
  questions: BatchQuestionState[];
};

export type RunSummary = {
  drafted: number;
  needsInput: number;
  skipped: number;
  failed: number;
};

/**
 * Runs in progress, in memory.
 *
 * A run lasts minutes and the API is a single instance, so this is the whole
 * store. A restart loses the progress report but not a single answer: each one
 * is written as it completes, which is the state that matters. If the API ever
 * runs more than one instance this moves to the database, and the reason it
 * would have to is written here rather than discovered.
 */
const runs = new Map<string, BatchRun>();

export function runFor(tenderId: string) {
  return runs.get(tenderId) ?? null;
}

export function isRunning(tenderId: string) {
  const run = runs.get(tenderId);
  return Boolean(run && !run.finishedAt);
}

export function summarise(run: BatchRun): RunSummary {
  return {
    drafted: run.questions.filter((question) => question.state === "drafted").length,
    needsInput: run.questions.filter((question) => question.state === "needs-input").length,
    skipped: run.questions.filter((question) => question.state === "skipped").length,
    failed: run.questions.filter((question) => question.state === "failed").length,
  };
}

/** Clears finished runs. Used by tests; a live server keeps one per tender. */
export function forgetRun(tenderId: string) {
  runs.delete(tenderId);
}

/**
 * Which questions this run will touch.
 *
 * An answer a person marked ready is left alone and reported as skipped, so
 * "Draft all" is safe to press twice — the second press does not quietly
 * replace the work somebody signed off.
 */
function planRun(questions: TenderAnalysis["questions"], answers: BidAnswer[]): BatchQuestionState[] {
  const ready = new Set(answers.filter((answer) => answer.status === "ready").map((answer) => answer.questionId));
  return questions.map((question) => ({
    questionId: question.id,
    title: question.title,
    state: ready.has(question.id) ? "skipped" : "pending",
  }));
}

export type Drafter = (input: {
  tender: TenderRecord;
  question: TenderAnalysis["questions"][number];
  context: Awaited<ReturnType<typeof draftContext>>;
  actor: string;
}) => Promise<{ outcome: DraftOutcome }>;

/**
 * Starts a run and returns its opening state.
 *
 * The work continues after this resolves. Callers report progress from
 * `runFor`, and every answer is saved as it lands rather than at the end.
 */
export async function startBatchDraft(args: {
  runId: string;
  account: string;
  tender: TenderRecord;
  actor: string;
  /**
   * How one question is drafted. The route never passes this; the tests do, so
   * the run's ordering, isolation and progress can be exercised without
   * spending twelve model calls on every CI build.
   */
  drafter?: Drafter;
}): Promise<BatchRun> {
  const drafter: Drafter = args.drafter ?? draftAndSaveAnswer;
  const questions = args.tender.analysis?.questions ?? [];
  const context = await draftContext(args.account, args.tender.id);
  const states = planRun(questions, context.existingAnswers);

  const run: BatchRun = {
    id: args.runId,
    tenderId: args.tender.id,
    startedAt: new Date().toISOString(),
    total: states.length,
    completed: states.filter((state) => state.state === "skipped").length,
    questions: states,
  };
  runs.set(args.tender.id, run);

  const queue = questions.filter((question) =>
    states.find((state) => state.questionId === question.id)?.state === "pending");

  const drafting = (async () => {
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const question = queue[next];
        next += 1;
        const state = run.questions.find((entry) => entry.questionId === question.id)!;
        state.state = "drafting";
        try {
          const { outcome } = await drafter({
            tender: args.tender, question, context, actor: args.actor,
          });
          applyOutcome(state, outcome);
        } catch (error) {
          // One question's failure costs one question. The run continues and
          // the failure is named, because "drafting failed" tells nobody which
          // of twelve answers they now have to write themselves.
          state.state = "failed";
          state.error = error instanceof Error ? error.message : "Drafting failed";
          log("error", {
            job: "draft-all", tenderId: args.tender.id, questionId: question.id, message: state.error,
          });
        } finally {
          run.completed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    run.finishedAt = new Date().toISOString();
    log("info", { job: "draft-all", tenderId: args.tender.id, ...summarise(run) });
  })();

  // Failures inside the run are recorded per question; this catch exists so an
  // unexpected one cannot become an unhandled rejection that takes the process
  // with it.
  drafting.catch((error) => {
    run.finishedAt = new Date().toISOString();
    log("error", { job: "draft-all", tenderId: args.tender.id, message: String(error) });
  });

  return run;
}

function applyOutcome(state: BatchQuestionState, outcome: DraftOutcome) {
  state.state = outcome.status === "needs-input" ? "needs-input" : "drafted";
  state.citations = outcome.citations;
}

/** Awaits the current run. Tests use it; the API never blocks on a run. */
export async function settleRun(tenderId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(tenderId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return runFor(tenderId);
}

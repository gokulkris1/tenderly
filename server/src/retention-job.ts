import "dotenv/config";
import { loadOperatorEnv } from "./ops-env.js";
import { applyRetention, closeDatabase, initializeDatabase, recordAudit } from "./db.js";
import { cutoffFor, retentionPolicy, summarise, SYSTEM_ORGANISATION_ID, type RetentionResult } from "./retention.js";
import { log } from "./logging.js";

// Run by hand from a laptop as often as by a scheduler, so it finds the
// operator credentials rather than demanding they be exported first.
loadOperatorEnv();

/**
 * Applies the retention policy and records what it did.
 *
 * Pass --dry-run to count without deleting. Deleting customer data is the one
 * operation where "run it and see" is not acceptable, so the safe mode exists
 * and the output names every tender it would remove.
 */
const dryRun = process.argv.includes("--dry-run");
const started = Date.now();

try {
  await initializeDatabase();
  const policy = retentionPolicy();
  const now = new Date();
  const outcome = await applyRetention(
    policy.map((entry) => ({ id: entry.id, label: entry.label, cutoff: cutoffFor(entry, now) })),
    { dryRun },
  );

  const result: RetentionResult = { ranAt: now.toISOString(), ...outcome };
  log("info", {
    job: "retention",
    dryRun,
    durationMs: Date.now() - started,
    summary: summarise(result),
    removed: result.removed,
    // Named, because "removed 14 things" is not something anyone can check.
    removedTenders: result.removedTenders,
    // Past the cutoff and deliberately kept, with the reason for each. A run
    // that retains a tender because it carries a provenance ledger is asking a
    // person to decide, and that request is worthless if nobody sees it.
    retained: result.retained,
  });

  // The audit log outlives the data it describes, which is the point of keeping
  // it longest: the record of a deletion has to survive the deletion.
  //
  // No longer swallowed. This write referenced an organisation that did not
  // exist until migration 028, so it raised a foreign-key violation on every
  // run — and the .catch() turned that into a log line, leaving the job free to
  // delete customer data and report success with no audit record that it had.
  // A deletion nobody can evidence is the one outcome this log exists to
  // prevent, so a failure to record it now fails the run.
  if (!dryRun) {
    try {
      await recordAudit({
        accountId: SYSTEM_ORGANISATION_ID,
        actor: "system:retention",
        action: "retention.applied",
        subjectType: "system", subjectId: "retention", subjectLabel: "Retention policy",
        // Named, not counted: "14 tenders" is not something anybody can check
        // after the rows are gone.
        metadata: { removed: result.removed, tenders: result.removedTenders, retained: result.retained.length },
      });
    } catch (error) {
      log("error", {
        job: "retention",
        message: `audit write failed: ${String(error)}`,
        consequence: "Data was deleted and the deletion is not recorded. Check migration 028 has run, then reconcile from this log.",
      });
      process.exitCode = 1;
    }
  }
} catch (error) {
  log("error", {
    job: "retention", dryRun, durationMs: Date.now() - started,
    message: error instanceof Error ? error.message : "Unexpected error",
  });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

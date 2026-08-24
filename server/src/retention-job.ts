import "dotenv/config";
import { applyRetention, closeDatabase, initializeDatabase, recordAudit } from "./db.js";
import { cutoffFor, retentionPolicy, summarise, type RetentionResult } from "./retention.js";
import { log } from "./logging.js";

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
  });

  // The audit log outlives the data it describes, which is the point of keeping
  // it longest: the record of a deletion has to survive the deletion.
  if (!dryRun) {
    await recordAudit({
      accountId: "00000000-0000-0000-0000-000000000000",
      actor: "system:retention",
      action: "retention.applied",
      subjectType: "system", subjectId: "retention", subjectLabel: "Retention policy",
      metadata: { removed: result.removed, tenders: result.removedTenders.length },
    }).catch((error) => log("error", { job: "retention", message: `audit write failed: ${String(error)}` }));
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

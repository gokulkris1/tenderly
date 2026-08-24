import "dotenv/config";
import { closeDatabase, deleteAccount, dueDeletions, initializeDatabase } from "./db.js";
import { log } from "./logging.js";

/**
 * Runs the deletions whose grace period has expired.
 *
 * Deliberately a separate process on a schedule rather than a timer inside the
 * API: the deletion has to happen even if nobody signs in again, and it has to
 * be visible in a log somebody reads. Pass --dry-run to list what is due without
 * deleting anything.
 */
const dryRun = process.argv.includes("--dry-run");
const started = Date.now();

try {
  await initializeDatabase();
  const due = await dueDeletions();
  let deleted = 0;
  for (const request of due) {
    if (dryRun) continue;
    // One account failing must not strand the rest: each is independent, and a
    // deletion that did not run is a deletion still owed to somebody.
    try {
      if (await deleteAccount(request.accountId, request.requestedBy, request.scheduledFor)) deleted += 1;
    } catch (error) {
      log("error", {
        job: "deletion", accountId: request.accountId,
        message: error instanceof Error ? error.message : "Unexpected error",
      });
    }
  }
  log("info", { job: "deletion", dryRun, due: due.length, deleted, durationMs: Date.now() - started });
} catch (error) {
  log("error", {
    job: "deletion", dryRun, durationMs: Date.now() - started,
    message: error instanceof Error ? error.message : "Unexpected error",
  });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

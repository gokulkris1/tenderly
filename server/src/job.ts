import "dotenv/config";
import { closeDatabase, initializeDatabase } from "./db.js";
import { runDiscoveryJob } from "./jobs.js";
import { log } from "./logging.js";

/**
 * The scheduled discovery run.
 *
 * Emits the same JSON line shape the API does, so one log query covers both:
 * a support question about a quiet Discover list is answered by the job's line,
 * not by a different format in a different place.
 */
const started = Date.now();
try {
  await initializeDatabase();
  const result = await runDiscoveryJob();
  log(result.healthy ? "info" : "error", {
    job: "discovery",
    outcome: result.healthy ? "ok" : "degraded",
    durationMs: Date.now() - started,
    opportunitiesChecked: result.opportunitiesChecked,
    matchesStored: result.matchesStored,
    sources: result.sources,
    alarms: result.alarms,
  });
  // A source that has stopped yielding is a failure of the run, not a detail
  // buried in its output: the exit status is what a scheduler actually reads.
  if (!result.healthy) process.exitCode = 1;
} catch (error) {
  log("error", {
    job: "discovery",
    outcome: "failed",
    durationMs: Date.now() - started,
    message: error instanceof Error ? error.message : "Unexpected error",
  });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

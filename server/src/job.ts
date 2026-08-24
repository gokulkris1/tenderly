import "dotenv/config";
import { closeDatabase, initializeDatabase } from "./db.js";
import { runDiscoveryJob } from "./jobs.js";

try {
  await initializeDatabase();
  const result = await runDiscoveryJob();
  console.log(JSON.stringify({ ok: result.healthy, ...result }));
  // A source that has stopped yielding is a failure of the run, not a detail
  // buried in its output: the exit status is what a scheduler actually reads.
  if (!result.healthy) {
    for (const alarm of result.alarms) console.error(`ingestion alarm · ${alarm}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

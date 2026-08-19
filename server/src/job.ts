import "dotenv/config";
import { closeDatabase, initializeDatabase } from "./db.js";
import { runDiscoveryJob } from "./jobs.js";

try {
  await initializeDatabase();
  const result = await runDiscoveryJob();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

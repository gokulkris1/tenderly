#!/usr/bin/env node
/**
 * Loads the OGP quarterly open dataset into award_history.
 *
 *   npm run import:ogp                    # streams the published dataset
 *   npm run import:ogp -- <path-or-url>   # a local copy or a specific quarter
 *
 * The file is ~63 MB, so it is streamed line by line and written in batches:
 * buffering it would hold the whole quarter in memory for no benefit.
 *
 * Idempotent: rows upsert on (source, external_id), so re-running the same
 * quarter updates rather than duplicating.
 */
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(path.join(repoRoot, "server"));

const ogp = await import(path.join(repoRoot, "server/dist/src/sources/ogp.js"));
const db = await import(path.join(repoRoot, "server/dist/src/db.js"));

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const source = arg ?? ogp.OGP_DATASET_URL;
const dryRun = process.argv.includes("--dry-run");
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);

async function lineStream(from) {
  if (/^https?:/.test(from)) {
    const res = await fetch(from);
    if (!res.ok) throw new Error(`${from} -> HTTP ${res.status}`);
    return createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  }
  return createInterface({ input: createReadStream(from), crlfDelay: Infinity });
}

console.log(`Importing award history from ${source}${dryRun ? " (dry run)" : ""}`);
await db.initializeDatabase();

let header = null;
let batch = [];
const counts = { rows: 0, skipped: 0, inserted: 0, updated: 0 };
const skipReasons = [];

async function flush() {
  if (dryRun || batch.length === 0) { batch = []; return; }
  const result = await db.saveAwards(batch);
  counts.inserted += result.inserted;
  counts.updated += result.updated;
  batch = [];
}

const seen = new Set();
let lineNumber = 0;
for await (const line of await lineStream(source)) {
  lineNumber++;
  if (!line.trim()) continue;
  const values = ogp.splitCsvLine(line);
  if (!header) {
    header = values;
    ogp.assertHeaders(header);   // a different file should stop the run, not fill the table with nonsense
    continue;
  }
  const record = ogp.rowToAward(header, values);
  if (record && seen.has(record.externalId)) { counts.skipped++; continue; }
  if (record) seen.add(record.externalId);
  if (!record) {
    counts.skipped++;
    if (skipReasons.length < 5) skipReasons.push(`line ${lineNumber}: no tender id or authority`);
    continue;
  }
  counts.rows++;
  batch.push(record);
  if (batch.length >= 500) await flush();
  if (limit && counts.rows >= limit) break;
}
await flush();

console.log(`  rows read      ${counts.rows}`);
console.log(`  skipped        ${counts.skipped}${skipReasons.length ? ` (${skipReasons[0]})` : ""}`);
if (!dryRun) {
  console.log(`  inserted       ${counts.inserted}`);
  console.log(`  updated        ${counts.updated}`);
  console.log(`  table total    ${await db.countAwards()}`);
}
console.log(`  ${ogp.AWARD_DATA_ATTRIBUTION}`);
await db.closeDatabase();

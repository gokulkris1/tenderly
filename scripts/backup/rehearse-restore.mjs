#!/usr/bin/env node
/**
 * Proves a backup by restoring it and checking what came back.
 *
 * An untested backup is not a backup. This is the test, and it runs in CI on
 * every pull request rather than being something somebody remembers to do once
 * a year: dump the database, restore it into an empty one, compare the row
 * count of every table, and compare the checksum of a stored vault document to
 * confirm its bytes survived.
 *
 *   DATABASE_URL=postgres://… node scripts/backup/rehearse-restore.mjs
 *
 * Deliberately depends on nothing but psql, pg_dump and pg_restore. A tool for
 * recovering the system must not need the system's own dependencies installed
 * to run — the day you need it is the day nothing else is working.
 *
 * Exits non-zero on any mismatch, and prints the evidence line that
 * docs/RUNBOOK_BACKUP.md records: date, operator, elapsed time.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);

const source = process.env.DATABASE_URL?.trim();
if (!source) {
  console.error("DATABASE_URL must be set to the database being rehearsed.");
  process.exit(2);
}

/**
 * The restore target: a separate database on the same server, dropped at the
 * end. Restoring over the source would make this script the disaster.
 */
const targetName = `tenderly_restore_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(source);
targetUrl.pathname = `/${targetName}`;

async function query(connectionString, sql) {
  const { stdout } = await run("psql", [String(connectionString), "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql]);
  return stdout.split("\n").filter(Boolean);
}

/**
 * The exact row count of every table the application owns, read from the
 * catalogue rather than from a list here — a table added next month is compared
 * without anybody remembering to add it.
 */
const COUNTS_SQL = `
  SELECT table_name,
         (xpath('/row/c/text()', query_to_xml(
            format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name`;

async function tableCounts(connectionString) {
  const counts = {};
  for (const line of await query(connectionString, COUNTS_SQL)) {
    const [table, count] = line.split("\t");
    counts[table] = Number(count);
  }
  return counts;
}

/**
 * One stored document, as a checksum of its bytes.
 *
 * Counting rows proves the metadata survived; only the bytes prove the
 * certificate did. Checksummed as stored, so that once documents are encrypted
 * (TLY-96) this same comparison is also the key-mismatch check.
 */
const DOCUMENT_SQL = `
  SELECT coalesce(filename, id::text), md5(bytes)
    FROM evidence_library WHERE bytes IS NOT NULL ORDER BY id LIMIT 1`;

async function sampleDocument(connectionString) {
  const [line] = await query(connectionString, DOCUMENT_SQL);
  if (!line) return null;
  const [filename, checksum] = line.split("\t");
  return { filename, checksum };
}

const started = Date.now();
const workspace = await mkdtemp(path.join(tmpdir(), "tenderly-restore-"));
const dumpFile = path.join(workspace, "tenderly.dump");
let created = false;

try {
  console.log("· dumping the source database");
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpFile, source]);

  const before = await tableCounts(source);
  const original = await sampleDocument(source);

  console.log(`· restoring into ${targetName}`);
  await run("psql", [String(adminUrl), "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${targetName}`]);
  created = true;
  // pg_restore reports notices through a non-zero exit as well as failures, so
  // its status is not the check — the comparison below is.
  await run("pg_restore", ["--no-owner", "--no-privileges", "--dbname", String(targetUrl), dumpFile])
    .catch((error) => console.log(`  pg_restore reported: ${String(error.stderr ?? error).trim().slice(0, 400)}`));

  const after = await tableCounts(String(targetUrl));

  const problems = [];
  for (const [table, count] of Object.entries(before)) {
    if (after[table] === undefined) problems.push(`${table}: missing from the restore`);
    else if (after[table] !== count) problems.push(`${table}: ${count} rows became ${after[table]}`);
  }
  for (const table of Object.keys(after)) {
    if (before[table] === undefined) problems.push(`${table}: in the restore but not in the source`);
  }

  if (!original) {
    console.log("· no stored document in this database, so only row counts were compared");
  } else {
    const restored = await sampleDocument(String(targetUrl));
    if (!restored) problems.push("vault document: nothing came back");
    else if (restored.checksum !== original.checksum) {
      problems.push(`vault document ${original.filename}: bytes differ after the restore`);
    } else {
      console.log(`· vault document "${original.filename}" restored byte for byte`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const operator = process.env.GITHUB_ACTIONS
    ? `GitHub Actions (${process.env.GITHUB_WORKFLOW ?? "workflow"} run ${process.env.GITHUB_RUN_ID ?? "?"})`
    : process.env.USER || "unknown operator";

  if (problems.length > 0) {
    console.error(`✗ restore verification failed after ${elapsed}s:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${Object.keys(before).length} tables restored with matching row counts`);
    console.log(`REHEARSAL ${new Date().toISOString().slice(0, 10)} · ${operator} · ${elapsed}s · ${Object.keys(before).length} tables`);
  }
} finally {
  if (created) await run("psql", [String(adminUrl), "-c", `DROP DATABASE IF EXISTS ${targetName}`]).catch(() => {});
  await rm(workspace, { recursive: true, force: true });
}

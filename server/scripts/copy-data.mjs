#!/usr/bin/env node
/**
 * Copies the committed reference data next to the compiled output.
 *
 * tsc compiles TypeScript and copies nothing else, so a build produced a dist
 * with no data directory and the server died on its first line of startup
 * reading the CPV list. The build is not finished until the things the code
 * reads at runtime are where the code will look for them.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const from = path.join(here, "data");
const to = path.join(here, "dist", "data");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

const copied = await readdir(to);
if (!copied.includes("cpv-2008.csv")) {
  console.error(`copy-data: cpv-2008.csv is missing from ${to} — the server will not start without it.`);
  process.exit(1);
}
console.log(`copy-data: ${copied.length} file(s) -> dist/data (${copied.join(", ")})`);

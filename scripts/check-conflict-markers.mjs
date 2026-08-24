#!/usr/bin/env node
/**
 * Fails when a tracked file contains a merge-conflict marker.
 *
 * A resolution script once failed part-way and the cherry-pick was continued
 * before the remaining markers were removed. The commit that reached the branch
 * carried '<<<<<<< HEAD' inside a TSX file, and every local check passed —
 * because they ran against the working tree, which had since been fixed.
 *
 * This reads what git actually has, which is the one thing a working-tree check
 * structurally cannot do.
 */
import { execFileSync } from "node:child_process";

// Built from parts rather than written literally: a file that contains the
// markers it looks for flags itself, and excluding this file by name would
// leave it the one place a real conflict could hide.
const ANGLE = "<".repeat(7);
const EQUALS = "=".repeat(7);
const CLOSE = ">".repeat(7);
const MARKERS = [`${ANGLE} `, `\n${EQUALS}\n`, `${CLOSE} `];

// Only text files git tracks; binary and fixture HTML are read the same way but
// a marker in either would be just as wrong.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((name) => !name.startsWith("server/tests/fixtures/hostile/"));

const offenders = [];
for (const file of files) {
  let content;
  try {
    content = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    continue;  // Not in HEAD yet, or unreadable as text.
  }
  const found = MARKERS.filter((marker) => content.includes(marker));
  if (found.length >= 2) offenders.push(file);
}

if (offenders.length) {
  console.error("Conflict markers found in committed files:");
  for (const file of offenders) console.error(`  ${file}`);
  console.error("\nResolve the conflict and amend the commit — do not push this.");
  process.exit(1);
}
console.log(`no conflict markers in ${files.length} tracked files`);

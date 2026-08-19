#!/usr/bin/env node
/**
 * Typechecks every project in the repository and reports all of them.
 *
 * Deliberately does not stop at the first failure: a change to the shared wire
 * types usually breaks the web app and the server together, and seeing only one
 * half of that hides the real blast radius.
 */
import { spawnSync } from "node:child_process";

const projects = [
  ["web", "tsconfig.typecheck.json"],
  ["shared", "packages/shared/tsconfig.json"],
  ["server", "server/tsconfig.json"],
];

let failed = 0;
for (const [name, project] of projects) {
  const res = spawnSync("npx", ["tsc", "--noEmit", "-p", project], { stdio: "inherit" });
  const ok = res.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} typecheck: ${name} (${project})`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);

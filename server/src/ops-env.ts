import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Credentials for the scripts a person runs by hand.
 *
 * The jobs that run on Render get their environment from Render. The scripts an
 * operator runs from a laptop — seeding, deletions, setting a password — get
 * nothing, and failed with "DATABASE_URL must be set" while the value sat in
 * ~/.tenderly/secrets.env all along. Telling somebody to export it first is a
 * step they will forget at the exact moment they are already frustrated.
 *
 * Anything already in the environment wins, so Render and CI are unaffected and
 * a deliberate override on the command line still works.
 */
const SECRETS_FILE = path.join(homedir(), ".tenderly", "secrets.env");

export function loadOperatorEnv(file = SECRETS_FILE) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { loaded: 0, file, found: false };
  }

  let loaded = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Set only what is missing: the environment is the more specific answer.
    if (process.env[key] !== undefined && process.env[key] !== "") continue;

    let value = trimmed.slice(at + 1).trim();
    // Values are quoted in this file precisely because a Postgres URL carries
    // an ampersand, and an unquoted one truncates the value to nothing.
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    // Trailing whitespace in a credentials file is invisible and fatal: an
    // email with a space on the end authenticates as nobody, and the 401 that
    // comes back says nothing about why. Unquoted values were always trimmed by
    // the shell; quoting them preserved the space and broke Jira auth twice
    // before anyone thought to look at the character count.
    process.env[key] = value.trim();
    loaded += 1;
  }
  return { loaded, file, found: true };
}

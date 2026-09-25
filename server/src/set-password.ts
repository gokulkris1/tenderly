import "dotenv/config";
import { loadOperatorEnv } from "./ops-env.js";
import { createInterface } from "node:readline";
import bcrypt from "bcryptjs";
import pg from "pg";

// Run by hand from a laptop as often as by a scheduler, so it finds the
// operator credentials rather than demanding they be exported first.
loadOperatorEnv();

/**
 * Sets the password on an existing account.
 *
 * There is no password reset flow yet, and the only account holding a real
 * board is one nobody can currently sign in to. This is the smallest honest
 * bridge: the operator types a password, it is hashed here, and only the hash
 * reaches the database. The password is never printed, never logged, never
 * passed as an argument where `ps` could read it, and never leaves this
 * machine.
 *
 *   npm run set-password --prefix server -- someone@example.com
 *
 * It refuses to create an account. Registering is a person choosing to join;
 * this only changes a credential on an account that already exists.
 */

const email = process.argv[2]?.trim();
if (!email) {
  console.error("usage: npm run set-password --prefix server -- <email>");
  process.exit(2);
}

/** Reads a line without echoing it, so the password never appears on screen. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    const rl = createInterface({ input, output: process.stdout, terminal: true });
    const onData = (chunk: Buffer | string) => {
      // Re-print the prompt with no echo of what was typed.
      const text = String(chunk);
      if (!text.includes("\n") && !text.includes("\r")) process.stdout.write(`\r${prompt}`);
    };
    process.stdout.write(prompt);
    input.on("data", onData);
    rl.question("", (answer) => {
      input.off("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL must be set.");
  process.exit(2);
}

const password = await askHidden(`New password for ${email} (hidden): `);
if (password.trim().length < 10) {
  console.error("Passwords must be at least 10 characters. Nothing was changed.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
try {
  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query("UPDATE users SET password_hash=$2 WHERE lower(email)=lower($1)", [email, hash]);
  if (!result.rowCount) {
    console.error(`No account for ${email}. This script does not create accounts — register in the app instead.`);
    process.exitCode = 1;
  } else {
    console.log(`Password set for ${email}. Existing sessions are unaffected; sign in with the new one.`);
  }
} finally {
  await pool.end();
}

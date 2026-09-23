import "dotenv/config";
import { closeDatabase, findUserByEmail, getPreferences, initializeDatabase, savePreferences, updateCompany } from "./db.js";
import { log } from "./logging.js";

/**
 * Puts Ingenie Technologies into the database as the company of record.
 *
 * Every judgement the product makes is relative to one company profile: what
 * matches at 05:00, whether an eligibility gate passes, what a drafted answer
 * is allowed to cite. An empty profile means the morning board is empty and
 * every answer is [INPUT NEEDED], so this is the first thing that has to be
 * true in a new environment.
 *
 *   npm run seed:ingenie --prefix server
 *
 * Idempotent: it updates the profile rather than creating a second one, so it
 * is safe to re-run after a restore or a migration.
 *
 * It deliberately does not create the sign-in. Registering is a person choosing
 * a password, and a seed script inventing one would leave an account whose
 * credentials nobody chose and everybody could read in the repository.
 */

const OWNER_EMAIL = process.env.TENDERLY_OWNER_EMAIL?.trim() || "gokulkris1@gmail.com";

/**
 * CPV 72000000 is "IT services: consulting, software development, Internet and
 * support" — the whole family. Buyers tag the specific child (72413000 for web
 * development, 72322000 for data services), and a family match includes every
 * one of them, which is what "all tenders matching this CPV" means.
 */
const CPV_CODES = ["72000000"];

const COMPANY = {
  name: "Ingenie Technologies Limited",
  registration: "703064",
  turnover: "",
  employees: "",
  services: "",
  cpv: CPV_CODES.join(" "),
  certifications: "",
  insurance: "",
  // Everything a tender response or a declaration asks for that the fixed
  // columns have no room for. These are facts about the company, supplied by
  // its director, not things the product inferred.
  vatNumber: "3798027FH",
  taxReference: "3798027FH",
  companyNumber: "703064",
  director: "Gokul Krishna",
  iban: "IE80BOFI90969529370101",
  incorporatedOn: "2021-09-03",
  website: "https://ingenie.ie",
  // Not supplied. It renders as a gap so a buyer never receives an invented
  // phone number, and so the profile meter can name what is missing.
  phone: "[INPUT NEEDED: contact number]",
};

const started = Date.now();
try {
  await initializeDatabase();
  const user = await findUserByEmail(OWNER_EMAIL);

  if (!user) {
    log("error", {
      job: "seed-ingenie",
      message: `No account for ${OWNER_EMAIL}. Register in the app first, then re-run this — a seed script will not invent a password.`,
    });
    process.exitCode = 1;
  } else if (!user.organisationId) {
    log("error", { job: "seed-ingenie", message: `${OWNER_EMAIL} has no organisation. Check migrations 024 and 025 have run.` });
    process.exitCode = 1;
  } else {
    await updateCompany(user.organisationId, COMPANY);

    // Preferences carry the discovery filter. The existing value band is kept:
    // if somebody has already set one, a seed re-run must not quietly widen
    // what lands on their board.
    const existing = await getPreferences(user.organisationId);
    await savePreferences(user.organisationId, {
      ...existing,
      cpvCodes: [...new Set([...existing.cpvCodes, ...CPV_CODES])],
    });

    log("info", {
      job: "seed-ingenie",
      durationMs: Date.now() - started,
      organisationId: user.organisationId,
      company: COMPANY.name,
      cpvCodes: CPV_CODES,
      note: "Turnover, employees, services and certifications are deliberately blank: they are the owner's to supply, and an invented figure in a tender response is the one thing this product must never produce.",
    });
  }
} catch (error) {
  log("error", {
    job: "seed-ingenie",
    durationMs: Date.now() - started,
    message: error instanceof Error ? error.message : "Unexpected error",
  });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

#!/usr/bin/env node
/**
 * Puts staging into a known state so end-to-end journeys and manual testers start
 * from the same place every time.
 *
 *   DATABASE_URL=... npm run seed:staging
 *
 * Idempotent: re-running updates the demo account rather than creating a second
 * one. Deterministic: the analysis is a fixture, so no model call is made and the
 * same gates, questions and blockers appear every run.
 *
 * Refuses to run against a host named in PRODUCTION_DB_HOSTS.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// db.js resolves migrations/ relative to cwd.
process.chdir(path.join(repoRoot, "server"));

const DEMO_EMAIL = process.env.SEED_EMAIL ?? "demo@tenderly.example";
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "tenderly-staging-demo-password";

// --- guards ------------------------------------------------------------------
const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is required. Seeding an in-memory database would do nothing.");
  process.exit(2);
}
const host = url.replace(/.*@/, "").split("/")[0];
const forbidden = (process.env.PRODUCTION_DB_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
if (forbidden.some((h) => host.includes(h))) {
  console.error(`Refusing to seed: ${host} is listed in PRODUCTION_DB_HOSTS. Seed data must never reach production.`);
  process.exit(3);
}
if (!/(^|[^a-z])example([^a-z]|$)/i.test(DEMO_EMAIL)) {
  console.error(`Refusing to seed: ${DEMO_EMAIL} is not on a reserved example domain.`);
  process.exit(4);
}

// bcryptjs lives in the server's install, not the root one.
const { default: bcrypt } = await import(path.join(repoRoot, "server/node_modules/bcryptjs/index.js"));
const db = await import(path.join(repoRoot, "server/dist/src/db.js"));
const { withStableIds } = await import(path.join(repoRoot, "server/dist/src/analysis-schema.js"));

console.log(`Seeding ${host}`);
await db.initializeDatabase();

// --- account -----------------------------------------------------------------
let user = await db.findUserByEmail(DEMO_EMAIL);
if (!user) {
  user = await db.createUser(DEMO_EMAIL, await bcrypt.hash(DEMO_PASSWORD, 12), "Tenderly Demo Ltd");
  console.log(`  created demo account ${DEMO_EMAIL}`);
} else {
  console.log(`  reusing demo account ${DEMO_EMAIL}`);
}
const account = user.id;

await db.updateCompany(account, {
  name: "Tenderly Demo Ltd",
  registration: "IE 456789",
  turnover: "EUR 4,200,000 (2025), EUR 3,800,000 (2024), EUR 3,100,000 (2023)",
  employees: "38",
  services: "Custom software development, software testing and QA, cloud migration",
  cpv: "72230000, 72820000",
  certifications: "ISO 9001:2015, ISO 27001:2022",
  insurance: "Employers Liability EUR 13,000,000; Professional Indemnity EUR 2,000,000",
});
console.log("  company profile set");

await db.savePreferences(account, {
  sectors: ["software-development", "software-testing"],
  keywords: [], cpvCodes: [], valueMin: null, valueMax: null,
});
console.log("  discovery preferences set to the two software sectors");

// --- evidence: one unverified, so the verify journey has something to act on ---
const existingEvidence = await db.listEvidence(account);
const evidenceSeed = [
  { kind: "Certificate", name: "ISO 9001:2015 certificate", content: "ISO 9001:2015 certified for software development and testing services, valid to 30 September 2027.", tags: ["quality"], verified: true },
  { kind: "Insurance", name: "Professional Indemnity schedule", content: "Professional Indemnity indemnity limit EUR 2,000,000, valid to 31 May 2027.", tags: ["insurance"], verified: true },
  { kind: "Certificate", name: "Tax Clearance Certificate", content: "Tax Clearance Certificate valid to 31 December 2026.", tags: ["tax"], verified: false },
];
for (const item of evidenceSeed) {
  if (existingEvidence.some((e) => e.name === item.name)) continue;
  await db.addEvidence(account, item);
}
console.log(`  evidence library: ${evidenceSeed.length} items (one deliberately unverified)`);

const existingPeople = await db.listPeople(account);
const peopleSeed = [
  { name: "Aoife Brennan", title: "Delivery Lead", cvText: "12 years delivering public-sector software. Chartered Engineer (Engineers Ireland, 2018). Led HSE case-management rollout.", skills: ["delivery management", "public sector", "agile"] },
  { name: "Cormac Daly", title: "Test Lead", cvText: "9 years in software testing and QA. ISTQB Advanced. Built automated regression suites for revenue-collection platforms.", skills: ["test automation", "istqb", "performance testing"] },
];
for (const person of peopleSeed) {
  if (existingPeople.some((p) => p.name === person.name)) continue;
  await db.addPerson(account, person);
}
console.log(`  team: ${peopleSeed.length} people with CVs`);

// --- tenders ------------------------------------------------------------------
const evidence = { sourceDocument: "Invitation to Tender.pdf", quote: "Tenderers shall hold ISO 9001 certification.", confidence: "HIGH" };
const question = (title, prompt) => ({ id: "placeholder", title, prompt, weight: 40, maxWords: 700, required: true, evidenceNeeded: ["Quality certification"], source: evidence });

function analysisFor({ decision, eligibility, gates, checklist }) {
  return withStableIds({
    headline: "Seeded analysis for staging",
    executiveSummary: "Deterministic fixture analysis created by the staging seed. No model call was made.",
    bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS", eligibility,
    fitScore: decision === "GO" ? 82 : 61, decision, partnerNeeded: false, partnerGaps: [],
    deadline: "26/03/2026 12:00", clarificationDeadline: "12/03/2026 17:00",
    contractValue: "EUR 450,000", duration: "24 months", lots: [],
    fatalGates: gates, evaluationCriteria: [],
    questions: [question("Quality management system", "Describe your quality management system and how it is audited."),
                question("Test approach", "Describe your approach to software testing and quality assurance.")],
    roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders portal",
    submissionChecklist: checklist, synopsisSlides: [{ title: "The opportunity", bullets: ["Open competition", "EUR 450,000", "Closes 26 March"] }],
  });
}

const passGate = { id: "quality", requirement: "ISO 9001 certification", bidderEvidence: "ISO 9001:2015 certificate on file", status: "PASS", action: "None", evidence };
const reviewGate = { id: "tax", requirement: "Current Tax Clearance Certificate", bidderEvidence: "Certificate present but not yet verified", status: "REVIEW", action: "Verify the tax clearance certificate", evidence };
const readyItem = { id: "response", label: "Tender response", required: true, kind: "RESPONSE", status: "READY", source: evidence };
const actionItem = { id: "taxcert", label: "Tax clearance certificate", required: true, kind: "SIGNATURE", status: "ACTION", source: evidence };

const seedTenders = [
  {
    externalId: "SEED-READY-001", title: "Software Testing and QA Services (seeded — ready)",
    analysis: analysisFor({ decision: "GO", eligibility: "PASS", gates: [passGate], checklist: [readyItem] }),
    answers: true,
  },
  {
    externalId: "SEED-BLOCKED-002", title: "Application Development Framework (seeded — blocked)",
    analysis: analysisFor({ decision: "REVIEW", eligibility: "REVIEW", gates: [passGate, reviewGate], checklist: [readyItem, actionItem] }),
    answers: false,
  },
];

for (const seed of seedTenders) {
  const tender = await db.upsertTender(account, {
    source: "seed", externalId: seed.externalId, title: seed.title,
    authority: "Sample Contracting Authority", procedure: "Open", deadline: "26/03/2026 12:00",
    estimatedValue: "EUR 450,000", description: "Seeded staging tender.",
    sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=SEED",
    published: "01/03/2026", status: "ANALYSED", metadata: {},
  });
  await db.saveTenderAnalysis(account, tender.id, seed.analysis);
  if (seed.answers) {
    for (const q of seed.analysis.questions) {
      await db.saveAnswer(tender.id, q.id, "Seeded answer drafted from verified evidence. ISO 9001:2015 certified.", "ready", []);
    }
  } else {
    // One answer left needing input, so the [INPUT NEEDED] journey has a subject.
    const [first] = seed.analysis.questions;
    await db.saveAnswer(tender.id, first.id, "Our approach is described below. [INPUT NEEDED: current tax clearance certificate]", "needs-input", []);
  }
  console.log(`  tender ${seed.externalId}: ${seed.analysis.questions.length} questions, ${seed.answers ? "answers ready" : "one answer needing input"}`);
}

await db.closeDatabase();
console.log("\nSeed complete.");
console.log(`  sign in as ${DEMO_EMAIL}`);

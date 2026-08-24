import type { CompanyProfile, EligibilityGate, EvidenceRecord, RequiredCertificate, SourceEvidence } from "./types.js";

/**
 * Hard-gate eligibility, decided in code rather than by the model.
 *
 * Turnover thresholds, insurance levels and certificate requirements are
 * arithmetic against facts the company already supplied. Deciding them here
 * makes them reproducible, free and auditable, and narrows the model's job to
 * extracting the requirement rather than judging compliance.
 *
 * The product rule holds throughout: absent or conflicting evidence is REVIEW.
 * Never FAIL for a fact we simply do not have, and never PASS without one.
 */

export type GateStatus = "PASS" | "REVIEW" | "FAIL";

export type DeterministicGate = {
  id: string;
  requirement: string;
  status: GateStatus;
  /** What the company can show, or why nothing could be compared. */
  bidderEvidence: string;
  /** What the user must do next. Empty when nothing is needed. */
  action: string;
  /** The two numbers compared, when a comparison was possible. */
  required?: number;
  held?: number;
  evidence: SourceEvidence;
};

/**
 * Money as written in a tender or a profile: "EUR 6,500,000", "€2m", "2.5
 * million". Returns null when no figure can be read — which is REVIEW, not zero.
 */
export function parseAmount(value: string | undefined | null): number | null {
  if (!value) return null;
  const text = String(value).toLowerCase().replace(/,/g, "");
  const match = /(\d+(?:\.\d+)?)\s*(m|million|k|thousand|bn|billion)?/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2];
  if (unit === "m" || unit === "million") return n * 1_000_000;
  if (unit === "k" || unit === "thousand") return n * 1_000;
  if (unit === "bn" || unit === "billion") return n * 1_000_000_000;
  return n;
}

/**
 * A bare four-digit number in the plausible range is a year, not a sum. Profile
 * text is written as "EUR 3.4m in 2023", and reading 2023 as a turnover figure
 * would raise a false conflict. A currency marker or a unit suffix rescues it.
 */
function isYear(raw: string, currency: string | undefined, unit: string | undefined) {
  if (currency || unit) return false;
  if (!/^\d{4}$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1900 && n <= 2100;
}

/** Every distinct amount mentioned, so conflicting figures can be detected. */
export function allAmounts(value: string | undefined | null): number[] {
  if (!value) return [];
  const text = String(value).toLowerCase().replace(/,/g, "");
  const found: number[] = [];
  for (const m of text.matchAll(/(eur|euro|\u20AC)?\s*(\d+(?:\.\d+)?)\s*(m|million|k|thousand|bn|billion)?/g)) {
    const [, currency, raw, unit] = m;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (isYear(raw, currency, unit)) continue;
    found.push(unit === "m" || unit === "million" ? n * 1_000_000
      : unit === "k" || unit === "thousand" ? n * 1_000
      : unit === "bn" || unit === "billion" ? n * 1_000_000_000
      : n);
  }
  return [...new Set(found)];
}

const money = (n: number) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

/**
 * Compares one stated threshold against one held figure.
 *
 * - no requirement figure  -> REVIEW, quoting the requirement as found
 * - nothing held           -> REVIEW, naming what is missing
 * - conflicting held figures -> REVIEW, naming both
 * - held >= required       -> PASS
 * - held <  required       -> FAIL
 */
export function compareThreshold(args: {
  id: string;
  requirement: string;
  requirementText: string;
  heldText: string;
  heldLabel: string;
  evidence: SourceEvidence;
}): DeterministicGate {
  const required = parseAmount(args.requirementText);
  const held = allAmounts(args.heldText);

  if (required === null) {
    return {
      id: args.id, requirement: args.requirement, status: "REVIEW",
      bidderEvidence: args.heldText || "Nothing recorded",
      action: `Check the requirement by hand: no figure could be read from "${args.requirementText.slice(0, 80)}"`,
      evidence: args.evidence,
    };
  }
  if (held.length === 0) {
    return {
      id: args.id, requirement: args.requirement, status: "REVIEW",
      bidderEvidence: `No ${args.heldLabel} recorded in the company profile`,
      action: `Record your ${args.heldLabel}`,
      required, evidence: args.evidence,
    };
  }
  // More than one distinct figure is a conflict, not a best guess.
  const relevant = held.filter((n) => n >= 1000);
  if (relevant.length > 1) {
    return {
      id: args.id, requirement: args.requirement, status: "REVIEW",
      bidderEvidence: `Conflicting evidence: ${relevant.map(money).join(" and ")}`,
      action: `Confirm which ${args.heldLabel} figure applies`,
      required, evidence: args.evidence,
    };
  }
  const value = relevant[0] ?? held[0];
  const meets = value >= required;
  return {
    id: args.id,
    requirement: args.requirement,
    status: meets ? "PASS" : "FAIL",
    bidderEvidence: `${money(value)} recorded`,
    action: meets ? "" : `Raise your ${args.heldLabel} to at least ${money(required)}, or bid with a partner`,
    required, held: value,
    evidence: args.evidence,
  };
}

/**
 * Certificate gates. A certificate is held only when a VERIFIED evidence item
 * covers it — an unverified upload is REVIEW, never PASS.
 */
export function certificateGate(certificate: RequiredCertificate, evidence: EvidenceRecord[]): DeterministicGate {
  const words = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const needle = words(certificate.name);
  const overlaps = (item: EvidenceRecord) => {
    const haystack = words(`${item.name} ${item.kind}`);
    const shared = [...needle].filter((w) => haystack.has(w)).length;
    return needle.size > 0 && shared >= Math.min(2, needle.size);
  };
  const verified = evidence.find((item) => item.verified && overlaps(item));
  if (verified) {
    return {
      id: `cert-${certificate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      requirement: certificate.name, status: "PASS",
      bidderEvidence: `Evidenced by ${verified.name}`, action: "",
      evidence: certificate.evidence,
    };
  }
  const unverified = evidence.find((item) => !item.verified && overlaps(item));
  return {
    id: `cert-${certificate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    requirement: certificate.name,
    status: "REVIEW",
    bidderEvidence: unverified ? `${unverified.name} is on file but not verified` : "No verified evidence on file",
    action: unverified ? `Verify ${unverified.name}` : `Upload and verify your ${certificate.name}`,
    evidence: certificate.evidence,
  };
}

/** Does this requirement read as a turnover threshold? */
function isTurnoverGate(text: string) {
  return /turnover|annual revenue|financial standing/i.test(text);
}

/** Does this requirement read as an insurance-cover threshold? */
function isInsuranceGate(text: string) {
  return /insurance|indemnity|liability cover/i.test(text);
}

/**
 * Re-decides the gates the model produced, in code, wherever the decision is
 * arithmetic rather than judgement.
 *
 * The model still does the extraction — finding the threshold and quoting it —
 * but the PASS/REVIEW/FAIL verdict for turnover, insurance and certificates is
 * computed here from the quote and the company profile. Gates we cannot decide
 * deterministically are returned exactly as the model wrote them.
 *
 * Certificate gates the model omitted are appended, so a mandatory certificate
 * can never be silently absent from the gate list.
 */
export function reconcileGates(args: {
  gates: EligibilityGate[];
  company: CompanyProfile;
  requiredCertificates: RequiredCertificate[];
  evidence: EvidenceRecord[];
}): { gates: EligibilityGate[]; recomputed: string[] } {
  const recomputed: string[] = [];
  const asGate = (gate: DeterministicGate): EligibilityGate => ({
    id: gate.id, requirement: gate.requirement, bidderEvidence: gate.bidderEvidence,
    status: gate.status, action: gate.action, evidence: gate.evidence,
  });

  const gates = args.gates.map((gate) => {
    const text = `${gate.requirement} ${gate.evidence.quote}`;
    // The quote carries the threshold; the requirement line is often a paraphrase.
    const requirementText = `${gate.evidence.quote} ${gate.requirement}`;
    const decide = (heldText: string, heldLabel: string) =>
      compareThreshold({
        id: gate.id, requirement: gate.requirement, requirementText,
        heldText, heldLabel, evidence: gate.evidence,
      });

    let decided: DeterministicGate | null = null;
    if (isTurnoverGate(text)) decided = decide(args.company.turnover, "annual turnover");
    else if (isInsuranceGate(text)) decided = decide(args.company.insurance, "insurance cover");
    if (!decided) return gate;

    // A REVIEW we could not resolve leaves the model's own wording intact — it
    // is usually more informative than "no figure could be read".
    if (decided.status === "REVIEW" && decided.required === undefined) return gate;
    if (decided.status !== gate.status) recomputed.push(`${gate.requirement}: ${gate.status} -> ${decided.status}`);
    return asGate(decided);
  });

  const seen = new Set(gates.map((gate) => gate.requirement.toLowerCase().trim()));
  for (const certificate of args.requiredCertificates) {
    if (!certificate.mandatory) continue;
    if (seen.has(certificate.name.toLowerCase().trim())) continue;
    gates.push(asGate(certificateGate(certificate, args.evidence)));
    recomputed.push(`${certificate.name}: added as a mandatory certificate gate`);
  }
  return { gates, recomputed };
}

/**
 * The overall eligibility verdict follows the worst gate: any FAIL is FAIL, any
 * REVIEW is REVIEW, and PASS requires every gate to have passed. NOT_APPLICABLE
 * gates are ignored. An empty gate list is REVIEW — nothing was checked.
 */
export function rollUpEligibility(gates: EligibilityGate[]): "PASS" | "FAIL" | "REVIEW" {
  const relevant = gates.filter((gate) => gate.status !== "NOT_APPLICABLE");
  if (relevant.length === 0) return "REVIEW";
  if (relevant.some((gate) => gate.status === "FAIL")) return "FAIL";
  if (relevant.some((gate) => gate.status === "REVIEW")) return "REVIEW";
  return "PASS";
}

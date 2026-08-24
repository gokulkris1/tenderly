import type { AuditEntry } from "./types.js";

/**
 * How long each class of data is kept.
 *
 * Holding every document and every answer forever is a liability and a
 * diligence question with no good answer. These are the defaults; each is
 * overridable by environment variable so a customer with a stricter or a
 * longer obligation is not stuck with ours.
 *
 * Audit entries are kept longest deliberately: the record of what happened to
 * the data has to outlive the data, or the record cannot be checked.
 */

export type RetentionClass = {
  id: string;
  label: string;
  months: number;
  /** What the period is measured from, in words a person can check. */
  measuredFrom: string;
};

const months = (name: string, fallback: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

export function retentionPolicy(): RetentionClass[] {
  return [
    {
      id: "closed-tenders", label: "Closed tenders and their documents",
      months: months("RETENTION_CLOSED_TENDERS_MONTHS", 24),
      measuredFrom: "the tender's submission deadline",
    },
    {
      id: "usage-events", label: "AI usage events",
      months: months("RETENTION_USAGE_MONTHS", 24),
      measuredFrom: "the metered call",
    },
    {
      id: "ingestion-runs", label: "Ingestion run records",
      months: months("RETENTION_INGESTION_MONTHS", 12),
      measuredFrom: "the run",
    },
    {
      id: "notifications", label: "Discovery notifications",
      months: months("RETENTION_NOTIFICATIONS_MONTHS", 12),
      measuredFrom: "the match",
    },
    {
      id: "audit-log", label: "Audit log",
      months: months("RETENTION_AUDIT_MONTHS", 84),
      measuredFrom: "the recorded action",
    },
  ];
}

/** The cut-off date for one class: anything older than this is removable. */
export function cutoffFor(entry: RetentionClass, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - entry.months);
  return cutoff;
}

export type RetentionResult = {
  ranAt: string;
  /** What was removed, per class. Zero counts are reported, not hidden. */
  removed: { id: string; label: string; count: number; cutoff: string }[];
  /** Named so the job's output can be checked against expectations. */
  removedTenders: { id: string; title: string }[];
  dryRun: boolean;
};

/** A one-line summary for the audit entry and the job's own log. */
export function summarise(result: RetentionResult) {
  const parts = result.removed.map((entry) => `${entry.id}=${entry.count}`);
  return `${result.dryRun ? "would remove" : "removed"} ${parts.join(" ")}`;
}

/** True when the audit log is the longest-lived class, which it must be. */
export function auditRetainedLongest(policy = retentionPolicy()) {
  const audit = policy.find((entry) => entry.id === "audit-log");
  if (!audit) return false;
  return policy.every((entry) => entry.id === "audit-log" || entry.months <= audit.months);
}

/** Shape of the audit metadata this job writes, so the test can assert it. */
export type RetentionAuditMetadata = Pick<AuditEntry, "metadata">["metadata"];

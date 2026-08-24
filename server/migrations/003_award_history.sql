-- TLY-30: historical awards from the OGP quarterly open dataset.
-- Shared reference data, NOT tenant-scoped: it is public information about who
-- won what, and every account draws intelligence from the same rows. It carries
-- no account_id deliberately, so the cross-tenant isolation suite does not flag it.
-- Licensed CC-BY-4.0 by the Office of Government Procurement; the attribution
-- travels with the rows so it cannot be shown without it.
CREATE TABLE IF NOT EXISTS award_history (
  id uuid PRIMARY KEY,
  source text NOT NULL DEFAULT 'ogp',
  external_id text NOT NULL,
  authority text NOT NULL,
  title text NOT NULL DEFAULT '',
  cpv text NOT NULL DEFAULT '',
  cpv_description text NOT NULL DEFAULT '',
  procedure text NOT NULL DEFAULT '',
  published_on date,
  awarded_on date,
  awarded_value numeric,
  estimated_value numeric,
  suppliers text NOT NULL DEFAULT '',
  bids_received integer,
  sme_bids_received integer,
  licence_note text NOT NULL DEFAULT 'Contains public sector information licensed under CC-BY-4.0, Office of Government Procurement (data.gov.ie)',
  UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS award_history_cpv_idx ON award_history(cpv);
CREATE INDEX IF NOT EXISTS award_history_authority_idx ON award_history(authority);

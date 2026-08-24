-- TLY-32: one opportunity, one row, however many portals published it.
--
-- The existing uniqueness is (account_id, source, external_id), which is by
-- construction per-source: the same above-threshold notice on eTenders and on
-- TED produced two rows, two bid records and a doubled match score.

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS canonical_key text;

CREATE INDEX IF NOT EXISTS tenders_canonical_key_idx ON tenders(account_id, canonical_key);

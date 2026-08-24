-- TLY-63: staff leave, and a departed person must stop appearing in role
-- matches without destroying the history of bids that cited them.
--
-- Archiving rather than deleting: a submitted bid named that person, and
-- rewriting the record would make the company's own past submissions
-- inconsistent with what the buyer received. Hard deletion is a GDPR
-- obligation handled separately (TLY-97), not a staffing action.

ALTER TABLE people ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE people ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS phone text;

CREATE INDEX IF NOT EXISTS people_active_idx ON people(account_id) WHERE archived_at IS NULL;

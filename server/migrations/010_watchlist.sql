-- TLY-39: the middle state between ignoring a notice and committing to a bid.
--
-- A notice was either ignored or imported as a full bid record with analysis
-- cost attached. Teams need somewhere to keep "interesting, watch the deadline,
-- decide later" without paying for everything they glance at.

CREATE TABLE IF NOT EXISTS watchlist (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The notice's own reference, not a tender id: nothing is imported yet.
  external_id text NOT NULL,
  title text NOT NULL,
  authority text NOT NULL DEFAULT '',
  deadline text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, external_id)
);

CREATE INDEX IF NOT EXISTS watchlist_account_idx ON watchlist(account_id, created_at DESC);

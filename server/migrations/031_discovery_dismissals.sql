-- Notices a workspace has dismissed from Discover.
--
-- Discovery is recomputed from the live portals on every view, so "not
-- interested" has to be its own record: the notice keeps arriving and the
-- dismissal is what keeps it off the list.

CREATE TABLE IF NOT EXISTS discovery_dismissals (
  account_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, external_id, source)
);

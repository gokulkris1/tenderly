-- TLY-38: several named filters per account, without editing the profile.
--
-- One preference profile serves the whole account, but a bid team looks at
-- different slices — "HSE energy work", "small local authority IT" — and had to
-- rewrite the profile to move between them.

CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- The same fields the preference profile uses, plus a buyer filter. Stored as
  -- JSON so a new filter field does not need a migration.
  filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Names are how a person picks a search, so they must be unique per account.
  UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS saved_searches_account_idx ON saved_searches(account_id, name);

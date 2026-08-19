-- TLY-34: what a company wants to see in Discover.
-- Sector presets are the user-facing lever; keywords and CPV codes are the
-- expansion underneath. Value bands are stored in whole euro.
CREATE TABLE IF NOT EXISTS discovery_preferences (
  account_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sectors jsonb NOT NULL DEFAULT '[]'::jsonb,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  cpv_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  value_min bigint,
  value_max bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

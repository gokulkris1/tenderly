-- EU-wide configurable geographic scope.
--
-- Workspace preferences watch a set of ISO 3166-1 alpha-3 markets (TED
-- place-of-performance); existing rows and the default stay Ireland, which is
-- what every account watched before this column existed. A tender board may
-- narrow or widen to its own markets; NULL means "the workspace's countries".

ALTER TABLE discovery_preferences
  ADD COLUMN IF NOT EXISTS countries jsonb NOT NULL DEFAULT '["IRL"]'::jsonb;

ALTER TABLE tender_boards
  ADD COLUMN IF NOT EXISTS countries jsonb;

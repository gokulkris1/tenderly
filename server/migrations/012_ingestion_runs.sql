-- TLY-33: what each source actually yielded, run by run.
--
-- Fixtures catch parser drift in CI, but production drift showed up only as a
-- quietly empty Discover list. Recording per-run counts is what lets a collapse
-- be noticed rather than inferred from a user's complaint.

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  notices_seen integer NOT NULL DEFAULT 0,
  notices_parsed integer NOT NULL DEFAULT 0,
  -- How many parsed notices carried each required field, e.g. {"deadline": 38}.
  field_coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Empty when the run was healthy; one line per problem when it was not.
  alarms jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingestion_runs_source_idx ON ingestion_runs(source, created_at DESC);

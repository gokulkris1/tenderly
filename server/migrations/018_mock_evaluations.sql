-- TLY-78: the mock evaluation, kept so two runs can be compared.
--
-- The value of a score is the movement between runs: rewrite the answer that
-- lost the marks, run it again, and see whether it actually recovered them. One
-- score in isolation is just a number.

CREATE TABLE IF NOT EXISTS mock_evaluations (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  -- Per-criterion marks, reasoning and gaps, as returned by the model.
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The weighted total, stored so history does not depend on recomputing it.
  total numeric NOT NULL DEFAULT 0,
  actor text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mock_evaluations_tender_idx ON mock_evaluations(tender_id, created_at DESC);

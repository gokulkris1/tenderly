-- TLY-45: buyers amend packs mid-competition.
--
-- Re-analysis overwrote the previous result, so nobody saw what changed and
-- drafted answers silently went stale against a moved deadline or a rewritten
-- requirement.
--
-- Versions are kept; tenders.analysis remains the current one, so every reader
-- of the current analysis is unaffected.

CREATE TABLE IF NOT EXISTS analysis_versions (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  analysis jsonb NOT NULL,
  -- Which versioned prompt and schema produced it, so a difference caused by
  -- our own change is distinguishable from one caused by the buyer's.
  prompt_version text NOT NULL DEFAULT '',
  schema_version text NOT NULL DEFAULT '',
  actor text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_versions_tender_idx ON analysis_versions(tender_id, created_at DESC);

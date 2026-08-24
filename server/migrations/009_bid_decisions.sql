-- TLY-50: the recommendation is advice; the company decides.
--
-- Nothing recorded that decision, so there was no basis for win/loss analytics
-- later and no trace of who chose to bid against a No-Go.

CREATE TABLE IF NOT EXISTS bid_decisions (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  -- What the company chose: 'BID' or 'NO_BID'.
  decision text NOT NULL CHECK (decision IN ('BID', 'NO_BID')),
  -- Mandatory when the choice goes against the recommendation.
  reason text NOT NULL DEFAULT '',
  decided_by text NOT NULL,
  -- The recommendation as it stood at the moment of the decision, so a later
  -- re-analysis cannot rewrite what the company was actually looking at.
  recommendation_at_the_time text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bid_decisions_tender_idx ON bid_decisions(tender_id, created_at DESC);

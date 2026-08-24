-- TLY-81: clarification exchanges with the buyer.
--
-- These live in email today, so the analysis never learns about them, two
-- people ask the same question, and an answer that changes a requirement never
-- reaches the draft.

CREATE TABLE IF NOT EXISTS clarifications (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  question text NOT NULL,
  asked_on text NOT NULL DEFAULT '',
  asked_by text NOT NULL DEFAULT '',
  -- Empty until the buyer answers.
  response text NOT NULL DEFAULT '',
  responded_on text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clarifications_tender_idx ON clarifications(tender_id, created_at DESC);

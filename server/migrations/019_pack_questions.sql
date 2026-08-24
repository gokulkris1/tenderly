-- TLY-44: questions asked of the tender pack, kept with their answers.
--
-- A bid team asks the same pack the same things repeatedly, and the answer to
-- "is a site visit mandatory" is worth keeping beside the tender rather than in
-- someone's memory.

CREATE TABLE IF NOT EXISTS pack_questions (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL DEFAULT '',
  -- Document name and the verbatim sentence, per citation.
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pack_questions_tender_idx ON pack_questions(tender_id, created_at DESC);

-- TLY-73: append-only ledger recording how every response section came to exist.
--
-- Buyers increasingly ask how a response was produced, and some prohibit
-- AI-generated content outright. The ledger is the honest answer to that
-- question, so it must never be rewritten after the fact.

CREATE TABLE IF NOT EXISTS answer_provenance (
  id uuid PRIMARY KEY,
  answer_id uuid NOT NULL REFERENCES bid_answers(id) ON DELETE CASCADE,
  -- Which part of the answer this entry covers. Whole-answer entries use 'body'.
  section text NOT NULL DEFAULT 'body',
  class text NOT NULL CHECK (class IN ('ai-generated', 'ai-assisted', 'human')),
  -- Null for human entries: nothing generated the text.
  model text,
  prompt_version text,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The account that caused the entry, as an email so the ledger stays readable
  -- after a user record is removed.
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS answer_provenance_answer_idx ON answer_provenance(answer_id, created_at);

-- Append-only, enforced in the database rather than only in the application.
-- The trigger raises rather than silently ignoring the statement, so a caller
-- that tries to rewrite history gets an error instead of a false success.
--
-- DELETE is deliberately left alone: the only deletion is the cascade from a
-- removed bid_answer, and a ledger for an answer that no longer exists has
-- nothing to attest to.
CREATE OR REPLACE FUNCTION answer_provenance_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'answer_provenance is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS answer_provenance_no_update ON answer_provenance;
CREATE TRIGGER answer_provenance_no_update
  BEFORE UPDATE ON answer_provenance
  FOR EACH ROW EXECUTE FUNCTION answer_provenance_append_only();

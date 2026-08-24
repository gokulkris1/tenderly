-- TLY-77: answers were overwritten in place.
--
-- A reviewer who rewrote a section could not compare it with the drafted
-- original, and an accidental overwrite of an approved answer was unrecoverable
-- the moment the page was saved.
--
-- Restoring writes a new version rather than rewinding, so this table is
-- append-only in the same way the provenance ledger is: history that can be
-- rewritten is not history.

CREATE TABLE IF NOT EXISTS answer_versions (
  id uuid PRIMARY KEY,
  answer_id uuid NOT NULL REFERENCES bid_answers(id) ON DELETE CASCADE,
  response text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  -- The provenance class this state was saved under, so a restored version
  -- carries the class of the text it restores rather than of the restoring.
  provenance_class text NOT NULL DEFAULT 'human',
  actor text NOT NULL DEFAULT '',
  -- Set when this version was produced by restoring an earlier one.
  restored_from uuid REFERENCES answer_versions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS answer_versions_answer_idx ON answer_versions(answer_id, created_at);

CREATE OR REPLACE FUNCTION answer_versions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'answer_versions is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS answer_versions_no_update ON answer_versions;
CREATE TRIGGER answer_versions_no_update
  BEFORE UPDATE ON answer_versions
  FOR EACH ROW EXECUTE FUNCTION answer_versions_append_only();

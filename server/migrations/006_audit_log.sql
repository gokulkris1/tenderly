-- TLY-79: append-only record of the actions that change what leaves the company.
--
-- Evidence verification, marking an answer ready, attestation, pack downloads
-- and document uploads all affect what a buyer eventually receives, and none of
-- them were recorded. Procurement customers expect traceability.

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The acting user's email, kept readable after a user record is removed.
  actor text NOT NULL,
  -- Dotted action name: 'evidence.verified', 'pack.final.downloaded'.
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  -- A label a person can recognise: a file name, an answer title.
  subject_label text NOT NULL DEFAULT '',
  -- Never document contents and never secrets: only what was acted on.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_account_idx ON audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(account_id, action, created_at DESC);

-- Append-only, enforced in the database rather than only in the application.
-- The trigger raises rather than ignoring the statement, so a caller trying to
-- rewrite the record gets an error instead of a false success.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

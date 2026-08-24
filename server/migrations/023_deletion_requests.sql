-- TLY-97: subject access and erasure.
--
-- Deletion is scheduled rather than immediate, so a mistake is recoverable
-- during the grace period. Nothing about the account is touched until the job
-- runs — a "pending deletion" that already broke things is not a grace period.

CREATE TABLE IF NOT EXISTS deletion_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deletion_requests_due_idx
  ON deletion_requests(scheduled_for) WHERE cancelled_at IS NULL;

-- The record that an erasure happened has to outlive the account it erased,
-- so this table deliberately has no foreign key back to users. It holds the
-- account identifier and who asked — the minimum needed to evidence that the
-- obligation was met — and nothing else about the person.
CREATE TABLE IF NOT EXISTS deletion_log (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

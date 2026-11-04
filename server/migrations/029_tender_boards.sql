CREATE TABLE IF NOT EXISTS tender_boards (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL,
  cpv_codes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS tender_boards_account_idx ON tender_boards(account_id);

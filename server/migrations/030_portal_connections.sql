-- The optional authenticated eTenders portal connection (Beta).
--
-- One row per organisation: the account's own eTenders credentials, stored
-- AES-256-GCM encrypted (see src/portal.ts) so a database read alone never
-- yields the password. Status starts "untested" and moves to "ok"/"failed"
-- only after a real login attempt — never on save.

CREATE TABLE IF NOT EXISTS portal_connections (
  account_id uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  email text NOT NULL,
  -- v1.<iv>.<tag>.<ciphertext>, base64 — AES-256-GCM under TENDERLY_PORTAL_KEY.
  password_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'ok', 'failed')),
  verified_at timestamptz,
  last_sync_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

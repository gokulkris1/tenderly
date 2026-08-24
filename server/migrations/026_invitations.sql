-- TLY-87: adding a colleague to an organisation.
--
-- The link that arrives by email is a secret, so what is stored here is its
-- SHA-256 and never the token itself. A leaked backup of this table lets nobody
-- into anybody's account.

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  -- SHA-256 of the token in the link. The token exists once, in that email.
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One live invitation per address per organisation. Re-inviting somebody whose
-- invitation lapsed is fine; two live links to the same inbox are confusing and
-- give two ways in where there should be one.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_idx
  ON invitations(organisation_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invitations_organisation_idx ON invitations(organisation_id, created_at DESC);

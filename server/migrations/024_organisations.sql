-- TLY-86, step 1 of the plan in docs/TENANCY.md: the tenant becomes an
-- organisation with members.
--
-- Additive only. Nothing points at these tables yet, so applying this file
-- changes no behaviour and can be stopped after safely.

CREATE TABLE IF NOT EXISTS organisations (
  id uuid PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Roles are enforced in TLY-88; the column exists now so the backfill does
  -- not have to be run twice.
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by text NOT NULL DEFAULT '',
  -- Null while an invitation is outstanding (TLY-87). Backfilled rows are
  -- accepted by definition: the person is already using the account.
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

-- Step 2: the backfill.
--
-- Each organisation takes the uuid of the user it came from. Every account_id
-- in every table already holds that value, so no row of customer data moves and
-- the repointing in 025 is a validation scan rather than a rewrite. This is the
-- single decision that makes this migration cheap and its rollback exact —
-- see docs/TENANCY.md.
INSERT INTO organisations(id, name, created_at)
SELECT u.id, COALESCE(c.name, ''), u.created_at
  FROM users u LEFT JOIN companies c ON c.account_id = u.id
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships(id, organisation_id, user_id, role, accepted_at, created_at)
SELECT gen_random_uuid(), u.id, u.id, 'owner', u.created_at, u.created_at
  FROM users u
ON CONFLICT (organisation_id, user_id) DO NOTHING;

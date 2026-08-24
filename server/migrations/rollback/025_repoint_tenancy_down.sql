-- Rollback for 024 and 025. See docs/TENANCY.md § Rollback before running it.
--
-- Run it against a copy first. It is exact and loses nothing only while every
-- organisation id is still also a user id — that is, before invitations ship
-- (TLY-87) and before any second member or second organisation exists. The
-- guards below refuse to run once that stops being true, because past that
-- point this is not a rollback, it is a deletion.
--
--   psql "$DATABASE_URL" -f server/migrations/rollback/025_repoint_tenancy_down.sql
--
-- Deploy the previous application release first: it reads account_id as a user
-- id, which is what this file restores.

BEGIN;

DO $$
DECLARE
  scoped text[] := ARRAY[
    'companies', 'tenders', 'evidence_library', 'people', 'notifications',
    'discovery_preferences', 'usage_events', 'audit_log', 'watchlist',
    'saved_searches', 'declarations', 'declaration_affirmations', 'deletion_requests'
  ];
  target text;
  offenders bigint;
BEGIN
  SELECT count(*) INTO offenders FROM organisations o
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.id);
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % organisations were created after the cutover and have no matching user. Rolling back would delete their tenders, answers, evidence, people and vault files. Restore from backup instead — see docs/TENANCY.md.',
      offenders;
  END IF;

  SELECT count(*) INTO offenders FROM (
    SELECT organisation_id FROM memberships GROUP BY organisation_id HAVING count(*) > 1
  ) AS multi;
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % organisations have more than one member. The previous schema cannot hold them, so those colleagues would lose access. See docs/TENANCY.md.',
      offenders;
  END IF;

  FOREACH target IN ARRAY scoped LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', target, target || '_account_org_fkey');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = target || '_account_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (account_id) REFERENCES users(id) ON DELETE CASCADE',
        target, target || '_account_id_fkey');
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS organisations;

COMMIT;

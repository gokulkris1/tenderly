-- TLY-86, steps 3 and 4 of docs/TENANCY.md: account_id stops meaning "a user"
-- and starts meaning "an organisation".
--
-- The column keeps its name, its values, its indexes and its unique
-- constraints. Only the foreign key's target moves. Because 024 gave each
-- organisation the uuid of the user it came from, every existing value already
-- validates, so ADD CONSTRAINT is a scan and not a rewrite — and no window
-- exists in which half the tables answer to a different parent.

DO $$
DECLARE
  -- Every table holding account_id with a foreign key to users. deletion_log
  -- holds the column deliberately without one, so the erasure record survives
  -- the cascade, and is absent here on purpose.
  scoped text[] := ARRAY[
    'companies', 'tenders', 'evidence_library', 'people', 'notifications',
    'discovery_preferences', 'usage_events', 'audit_log', 'watchlist',
    'saved_searches', 'declarations', 'declaration_affirmations', 'deletion_requests'
  ];
  target text;
  orphans bigint;
BEGIN
  -- Step 3: verify before touching a single foreign key. A row whose account_id
  -- names no organisation would fail the ADD CONSTRAINT halfway through and
  -- leave the schema in a state nobody designed.
  FOREACH target IN ARRAY scoped LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I t WHERE NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = t.account_id)',
      target) INTO orphans;
    IF orphans > 0 THEN
      RAISE EXCEPTION '% has % rows whose account_id names no organisation — run 024 first', target, orphans;
    END IF;
  END LOOP;

  SELECT count(*) INTO orphans FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.role = 'owner');
  IF orphans > 0 THEN
    RAISE EXCEPTION '% users have no owner membership — run 024 first', orphans;
  END IF;

  -- Step 4: repoint. Named constraints rather than the generated ones, so this
  -- file is idempotent: a second run finds the new constraint and does nothing.
  FOREACH target IN ARRAY scoped LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = target || '_account_org_fkey') THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', target, target || '_account_id_fkey');
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (account_id) REFERENCES organisations(id) ON DELETE CASCADE',
        target, target || '_account_org_fkey');
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN tenders.account_id IS
  'The organisation that owns this row. Named account_id for historical reasons; see docs/TENANCY.md.';

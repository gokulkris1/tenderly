-- TLY-84: blockers say what is unresolved, not who is doing it or by when.
--
-- Tasks generated from a blocker are keyed on the blocker's own text, so the
-- same blocker never produces a second task and resolving it completes the one
-- that exists.

CREATE TABLE IF NOT EXISTS bid_tasks (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- 'blocker' when generated from an unresolved item, 'manual' when added.
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('blocker', 'manual')),
  -- The owner's email. A membership reference lands with the org model (TLY-86).
  owner text NOT NULL DEFAULT '',
  due_on text NOT NULL DEFAULT '',
  -- Blocker tasks are completed by the blocker clearing, not by hand.
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One task per blocker per tender.
  UNIQUE (tender_id, title, origin)
);

CREATE INDEX IF NOT EXISTS bid_tasks_tender_idx ON bid_tasks(tender_id, created_at);
CREATE INDEX IF NOT EXISTS bid_tasks_owner_idx ON bid_tasks(owner) WHERE completed_at IS NULL;

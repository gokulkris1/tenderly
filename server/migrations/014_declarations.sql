-- TLY-57: answer the ESPD questions once, reuse them on every bid.
--
-- Irish public tenders require the European Single Procurement Document, and
-- companies re-answer the same self-declarations for every competition.

CREATE TABLE IF NOT EXISTS declarations (
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The declaration's stable identifier from src/declarations.ts.
  declaration_id text NOT NULL,
  -- 'yes' or 'no'. Null means unanswered.
  answer text,
  -- Mandatory when a Yes on an exclusion ground needs explaining.
  notes text NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, declaration_id)
);

-- One affirmation covers the whole set: a buyer asks when the declarations were
-- made, not when each line was last edited.
CREATE TABLE IF NOT EXISTS declaration_affirmations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affirmed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS declaration_affirmations_account_idx
  ON declaration_affirmations(account_id, created_at DESC);

-- Clarifications through the portal connection.
--
-- A message sent via the eTenders portal (or received from the buyer there)
-- is the same exchange as a manually recorded one, so it lives in the same
-- table. `origin` says which path created the row; `portal_message_id` is the
-- portal's own identifier, which is what keeps a re-sync from duplicating it.

ALTER TABLE clarifications
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in')),
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'portal')),
  ADD COLUMN IF NOT EXISTS portal_message_id text;

CREATE INDEX IF NOT EXISTS clarifications_portal_message_idx
  ON clarifications(tender_id, portal_message_id) WHERE portal_message_id IS NOT NULL;

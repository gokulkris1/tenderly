-- TLY-31: the published CPV 2008 list, and a normalised code on every tender.
--
-- Codes arrive as free text from three sources in inconsistent forms. Matching
-- a company's registered codes against a notice needs one canonical form plus
-- the ancestor chain, so a company registered against a division still matches
-- the narrower children underneath it.

CREATE TABLE IF NOT EXISTS cpv_codes (
  code text PRIMARY KEY,
  check_digit text NOT NULL DEFAULT '',
  description text NOT NULL,
  -- The nearest broader code that exists in the list. Null for a division.
  parent_code text,
  -- 1 for a division, rising to 5 for the most detailed categories.
  level integer NOT NULL
);

CREATE INDEX IF NOT EXISTS cpv_codes_parent_idx ON cpv_codes(parent_code);

-- The canonical eight-digit code for this notice, or null when the raw value
-- carries none. The raw string stays in metadata either way: a notice with an
-- unrecognised CPV is still a notice, and its own wording is shown unchanged.
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cpv_normalised text;

CREATE INDEX IF NOT EXISTS tenders_cpv_idx ON tenders(cpv_normalised);

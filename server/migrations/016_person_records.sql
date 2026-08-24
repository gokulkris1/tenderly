-- TLY-59: make a CV queryable instead of re-reading it on every analysis.
--
-- people.cv_text held raw extracted text and skills was a loose jsonb array, so
-- role matching depended on the model re-reading every CV in every analysis
-- call — expensive, unrepeatable and impossible to query.
--
-- Every row carries the quote it came from and lands unconfirmed: a parsed
-- claim about a named person is a suggestion until a human accepts it.

CREATE TABLE IF NOT EXISTS person_records (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- 'skill', 'role', 'certification' or 'experience'.
  record_type text NOT NULL CHECK (record_type IN ('skill', 'role', 'certification', 'experience')),
  value text NOT NULL,
  -- Issuing body for a certification, employer for an experience entry.
  detail text NOT NULL DEFAULT '',
  -- Year or date range exactly as the CV writes it. Never inferred.
  period text NOT NULL DEFAULT '',
  -- The sentence in the CV this was read from, so a reviewer can check it.
  quote text NOT NULL DEFAULT '',
  confidence text NOT NULL DEFAULT 'MEDIUM' CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS person_records_person_idx ON person_records(person_id, record_type);
CREATE INDEX IF NOT EXISTS person_records_value_idx ON person_records(record_type, lower(value));

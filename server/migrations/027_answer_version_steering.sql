-- TLY-72: refining an answer with a steering instruction.
--
-- The instruction is part of the history. "Shorten to 150 words" is why this
-- version differs from the one before it, and a version list that shows four
-- timestamps and no reasons is a list nobody can read.
--
-- The append-only trigger on this table is on UPDATE, so adding a column is
-- untouched by it.

ALTER TABLE answer_versions ADD COLUMN IF NOT EXISTS steering text NOT NULL DEFAULT '';

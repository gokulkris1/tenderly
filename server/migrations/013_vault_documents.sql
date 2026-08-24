-- TLY-53: keep the file, not just the text extracted from it.
--
-- The upload path extracted text and discarded the original bytes, so a buyer
-- asking for the tax clearance certificate could not be sent one.
--
-- These columns extend evidence_library rather than opening a second table.
-- Everything that already reads evidence — certificate matching, drafting, the
-- submission pack — keeps working unchanged, and a text-only row stays a valid
-- row with no file attached. A parallel vault_documents table would have meant
-- a dual-read path through all of that for no gain.

ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS bytes bytea;
ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS content_type text;
ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS filename text;
ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS size_bytes integer;

-- What a buyer asks about a certificate: who issued it and when it runs out.
ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS issuing_body text;
ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS issued_on text;
ALTER TABLE evidence_library ADD COLUMN IF NOT EXISTS expires_on text;

CREATE INDEX IF NOT EXISTS evidence_expiry_idx ON evidence_library(account_id, expires_on);

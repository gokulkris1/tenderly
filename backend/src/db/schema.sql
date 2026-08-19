-- Tenderly Database Schema (Neon PostgreSQL)

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  registration_number TEXT,
  address TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  expertise TEXT[], -- e.g. ['IT Consulting', 'Cloud Services']
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url TEXT,
  reference_number TEXT,
  title TEXT NOT NULL,
  contracting_authority TEXT,
  description TEXT,
  category TEXT,
  deadline TIMESTAMPTZ,
  estimated_value NUMERIC,
  currency TEXT DEFAULT 'EUR',
  framework_agreement BOOLEAN DEFAULT FALSE,
  framework_details JSONB,
  eligibility_criteria JSONB,
  documents JSONB,
  raw_html TEXT,
  status TEXT DEFAULT 'active', -- active, closed, awarded
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS synopsis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID REFERENCES tenders(id) ON DELETE CASCADE,
  slides JSONB NOT NULL, -- array of slide objects
  eligibility_result JSONB,
  recommendation TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bid_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID REFERENCES tenders(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id),
  status TEXT DEFAULT 'draft', -- draft, in_progress, completed
  form_data JSONB DEFAULT '{}',
  questions_responses JSONB DEFAULT '[]',
  uploaded_cvs JSONB DEFAULT '[]',
  zip_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id UUID REFERENCES bid_submissions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  storage_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

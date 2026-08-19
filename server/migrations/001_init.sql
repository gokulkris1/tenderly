CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  registration text NOT NULL DEFAULT '',
  turnover text NOT NULL DEFAULT '',
  employees text NOT NULL DEFAULT '',
  services text NOT NULL DEFAULT '',
  cpv text NOT NULL DEFAULT '',
  certifications text NOT NULL DEFAULT '',
  insurance text NOT NULL DEFAULT '',
  profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenders (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'etenders',
  external_id text,
  source_url text NOT NULL,
  title text NOT NULL,
  authority text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  procedure text NOT NULL DEFAULT '',
  deadline text NOT NULL DEFAULT '',
  published text NOT NULL DEFAULT '',
  estimated_value text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'IMPORTED',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  analysis jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, source, external_id)
);

CREATE TABLE IF NOT EXISTS tender_documents (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  role text NOT NULL DEFAULT 'source',
  source_url text,
  bytes bytea,
  extracted_text text NOT NULL DEFAULT '',
  extraction_status text NOT NULL DEFAULT 'EXTRACTED',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tender_documents_tender_idx ON tender_documents(tender_id);

CREATE TABLE IF NOT EXISTS bid_answers (
  id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  response text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tender_id, question_id)
);

CREATE TABLE IF NOT EXISTS evidence_library (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  content text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL DEFAULT '',
  cv_text text NOT NULL DEFAULT '',
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL,
  source_url text NOT NULL,
  match_score integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, external_id)
);

CREATE INDEX IF NOT EXISTS notifications_account_idx ON notifications(account_id, created_at DESC);

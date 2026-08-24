-- TLY-69: what every model call cost, per account.
--
-- AI calls are the product's main variable cost and nothing recorded them:
-- billing cannot gate on an allowance it cannot measure, support cannot explain
-- a slow account, and abuse of the analysis endpoint was invisible.

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the account asked for: 'analysis', 'draft', 'critique'.
  kind text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  -- The provider's request id, so a row can be reconciled against their billing.
  request_id text,
  -- Null for calls that are not about one tender.
  tender_id uuid REFERENCES tenders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_account_idx ON usage_events(account_id, created_at);

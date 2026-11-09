ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS itemization_mode TEXT NOT NULL DEFAULT 'LEGACY'
    CHECK (itemization_mode IN ('LEGACY', 'ITEMIZED'));

CREATE TABLE IF NOT EXISTS reimbursement.expense_items (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES reimbursement.claims(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES reimbursement.receipts(id) ON DELETE CASCADE,
  receipt_type TEXT NOT NULL DEFAULT '',
  expense_category TEXT NOT NULL DEFAULT '',
  category_source TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  purpose_source TEXT NOT NULL DEFAULT '',
  amount_cent BIGINT CHECK (amount_cent >= 0),
  amount_source TEXT NOT NULL DEFAULT '',
  project_code TEXT NOT NULL DEFAULT '',
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (category_source IN ('', 'MODEL', 'MANUAL')),
  CHECK (purpose_source IN ('', 'MODEL', 'MANUAL')),
  CHECK (amount_source IN ('', 'OCR', 'MANUAL'))
);

CREATE INDEX IF NOT EXISTS expense_items_claim_idx ON reimbursement.expense_items(claim_id, receipt_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.expense_items TO reimbursement_api;

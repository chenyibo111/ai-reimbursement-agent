ALTER TABLE reimbursement.expense_items
  ADD COLUMN IF NOT EXISTS classification_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (classification_status IN ('PENDING', 'CLASSIFIED', 'UNKNOWN', 'FAILED', 'CATEGORY_UNMAPPED')),
  ADD COLUMN IF NOT EXISTS classification_version TEXT NOT NULL DEFAULT '';

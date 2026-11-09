ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS purpose_source TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (purpose_source IN ('MANUAL', 'AUTO'));

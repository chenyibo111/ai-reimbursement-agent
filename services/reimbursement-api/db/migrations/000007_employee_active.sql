ALTER TABLE reimbursement.employees
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

GRANT SELECT (id, is_active) ON reimbursement.employees TO reimbursement_api;

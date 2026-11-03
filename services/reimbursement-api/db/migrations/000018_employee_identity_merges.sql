CREATE TABLE IF NOT EXISTS reimbursement.employee_identity_merges (
  duplicate_employee_id TEXT PRIMARY KEY REFERENCES reimbursement.employees(id),
  canonical_employee_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  tenant_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (duplicate_employee_id <> canonical_employee_id)
);

GRANT SELECT, INSERT ON reimbursement.employee_identity_merges TO reimbursement_api;

CREATE TABLE IF NOT EXISTS reimbursement.employee_members (
  tenant_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_members_employee_id_key
  ON reimbursement.employee_members(employee_id);

CREATE TABLE IF NOT EXISTS reimbursement.employee_identity_links (
  app_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, open_id),
  UNIQUE (tenant_key, user_id, app_id),
  FOREIGN KEY (tenant_key, user_id) REFERENCES reimbursement.employee_members(tenant_key, user_id)
);

GRANT SELECT, INSERT, UPDATE ON reimbursement.employee_members TO reimbursement_api;
GRANT SELECT, INSERT, UPDATE ON reimbursement.employee_identity_links TO reimbursement_api;

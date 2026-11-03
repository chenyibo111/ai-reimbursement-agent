CREATE TABLE IF NOT EXISTS reimbursement.sso_web_sessions (
  id_hash VARCHAR(64) PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  sid VARCHAR(255) NOT NULL,
  encrypted_id_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_web_sessions_sid_idx ON reimbursement.sso_web_sessions(sid);

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.sso_web_sessions TO reimbursement_api;

DO $$
BEGIN
  IF to_regclass('public."Employee"') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public."Employee" TO reimbursement_api;
  END IF;
END
$$;

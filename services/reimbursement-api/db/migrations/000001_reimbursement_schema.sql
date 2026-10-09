CREATE SCHEMA IF NOT EXISTS reimbursement;
CREATE SCHEMA IF NOT EXISTS agent;

DO $$
BEGIN
  CREATE ROLE reimbursement_api NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE agent_service NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS reimbursement.employees (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  department TEXT,
  feishu_user_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'EMPLOYEE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role IN ('EMPLOYEE', 'FINANCE_REVIEWER', 'ADMIN'))
);

GRANT USAGE ON SCHEMA reimbursement TO reimbursement_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.employees TO reimbursement_api;
REVOKE ALL ON SCHEMA reimbursement FROM agent_service;
REVOKE ALL ON ALL TABLES IN SCHEMA reimbursement FROM agent_service;

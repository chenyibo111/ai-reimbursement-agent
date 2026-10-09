CREATE TABLE IF NOT EXISTS reimbursement.claims (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  purpose TEXT NOT NULL,
  expense_category TEXT,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_code TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('DRAFT', 'SUBMITTED')),
  CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS reimbursement.claim_audits (
  id BIGSERIAL PRIMARY KEY,
  -- Keep the immutable reference after a user deletes a DRAFT claim.
  claim_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  action TEXT NOT NULL,
  claim_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.claims TO reimbursement_api;
GRANT SELECT, INSERT ON reimbursement.claim_audits TO reimbursement_api;
GRANT USAGE, SELECT ON SEQUENCE reimbursement.claim_audits_id_seq TO reimbursement_api;

CREATE TABLE IF NOT EXISTS reimbursement.policy_versions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  effective_date DATE NOT NULL,
  published_by TEXT REFERENCES reimbursement.employees(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_one_published_idx ON reimbursement.policy_versions ((status)) WHERE status = 'PUBLISHED';
CREATE TABLE IF NOT EXISTS reimbursement.review_cases (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES reimbursement.claims(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLAIMED','RESOLVED','CLOSED')),
  assigned_to TEXT REFERENCES reimbursement.employees(id),
  resolution TEXT,
  resolved_by TEXT REFERENCES reimbursement.employees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS reimbursement.review_case_audits (
  id BIGSERIAL PRIMARY KEY, review_case_id TEXT NOT NULL REFERENCES reimbursement.review_cases(id), actor_id TEXT NOT NULL REFERENCES reimbursement.employees(id), action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.policy_versions, reimbursement.review_cases TO reimbursement_api;
GRANT SELECT, INSERT ON reimbursement.review_case_audits TO reimbursement_api;
GRANT USAGE, SELECT ON SEQUENCE reimbursement.review_case_audits_id_seq TO reimbursement_api;

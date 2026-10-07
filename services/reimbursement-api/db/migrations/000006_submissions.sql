ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_number TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS reimbursement.submission_confirmations (
  token TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES reimbursement.claims(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  claim_version BIGINT NOT NULL,
  policy_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submission_confirmations_claim_actor_idx
  ON reimbursement.submission_confirmations (claim_id, actor_id, expires_at);

CREATE TABLE IF NOT EXISTS reimbursement.submission_snapshots (
  id BIGSERIAL PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES reimbursement.claims(id),
  actor_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  submission_number TEXT NOT NULL UNIQUE,
  claim_version BIGINT NOT NULL,
  policy_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (actor_id, claim_id, idempotency_key),
  UNIQUE (claim_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.submission_confirmations TO reimbursement_api;
GRANT SELECT, INSERT ON reimbursement.submission_snapshots TO reimbursement_api;
GRANT USAGE, SELECT ON SEQUENCE reimbursement.submission_snapshots_id_seq TO reimbursement_api;

ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS itemization_rollout_version BIGINT NOT NULL DEFAULT 0
  CHECK (itemization_rollout_version >= 0);

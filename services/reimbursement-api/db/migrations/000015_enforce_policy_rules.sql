ALTER TABLE reimbursement.policy_versions
  ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE reimbursement.policy_versions
  ADD CONSTRAINT policy_versions_rules_array CHECK (jsonb_typeof(rules) = 'array');

-- A future version must not remove the current effective version before its date.
DROP INDEX IF EXISTS reimbursement.policy_versions_one_published_idx;
CREATE INDEX IF NOT EXISTS policy_versions_effective_idx ON reimbursement.policy_versions (effective_date DESC, published_at DESC) WHERE status = 'PUBLISHED';

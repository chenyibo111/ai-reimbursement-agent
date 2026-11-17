ALTER TABLE reimbursement.receipts
  ADD COLUMN IF NOT EXISTS review_config_version BIGINT NOT NULL DEFAULT 0
  CHECK (review_config_version >= 0);

ALTER TABLE reimbursement.review_cases
  ADD COLUMN IF NOT EXISTS review_config_version BIGINT NOT NULL DEFAULT 0
  CHECK (review_config_version >= 0);

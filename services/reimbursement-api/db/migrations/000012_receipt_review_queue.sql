-- Receipt OCR review cases are actionable work for finance reviewers.  Keep
-- the original generic review-case fields nullable so existing, non-receipt
-- review cases remain compatible.
ALTER TABLE reimbursement.review_cases
  ADD COLUMN IF NOT EXISTS receipt_id TEXT REFERENCES reimbursement.receipts(id),
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE reimbursement.review_cases
  ADD CONSTRAINT review_cases_version_positive CHECK (version >= 1);

UPDATE reimbursement.review_cases
SET
  version = 1,
  updated_at = COALESCE(updated_at, created_at, now())
WHERE version IS NULL OR updated_at IS NULL;

-- Historical receipt transitions could write the same issue repeatedly.
-- Keep the earliest record, which preserves the first observed reason.
DELETE FROM reimbursement.receipt_review_issues AS duplicate
USING reimbursement.receipt_review_issues AS retained
WHERE duplicate.receipt_id = retained.receipt_id
  AND duplicate.code = retained.code
  AND duplicate.id > retained.id;

CREATE UNIQUE INDEX IF NOT EXISTS receipt_review_issues_receipt_code_key
  ON reimbursement.receipt_review_issues (receipt_id, code);

CREATE INDEX IF NOT EXISTS review_cases_receipt_idx
  ON reimbursement.review_cases (receipt_id)
  WHERE receipt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS review_cases_open_queue_idx
  ON reimbursement.review_cases (created_at ASC, id ASC)
  WHERE status IN ('OPEN', 'CLAIMED');

-- A receipt can be worked only once at a time.  Resolved and closed cases are
-- retained as history and do not prevent a later, genuinely new review.
CREATE UNIQUE INDEX IF NOT EXISTS review_cases_one_active_receipt_idx
  ON reimbursement.review_cases (receipt_id)
  WHERE receipt_id IS NOT NULL AND status IN ('OPEN', 'CLAIMED');

-- Backfill a deterministic OPEN case for historical receipts already marked
-- REVIEW_REQUIRED. Prefer the first issue recorded for that receipt, with a
-- safe legacy reason when historic rows did not include an issue.
WITH inserted_cases AS (
  INSERT INTO reimbursement.review_cases (
    id,
    claim_id,
    receipt_id,
    kind,
    reason_code,
    status,
    version,
    created_at,
    updated_at
  )
  SELECT
    'receipt-review-' || receipt.id,
    receipt.claim_id,
    receipt.id,
    'RECEIPT_OCR',
    COALESCE(issue.code, 'LEGACY_REVIEW_REQUIRED'),
    'OPEN',
    1,
    receipt.updated_at,
    receipt.updated_at
  FROM reimbursement.receipts AS receipt
  LEFT JOIN LATERAL (
    SELECT code
    FROM reimbursement.receipt_review_issues
    WHERE receipt_id = receipt.id
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  ) AS issue ON true
  WHERE receipt.status = 'REVIEW_REQUIRED'
    AND NOT EXISTS (
      SELECT 1
      FROM reimbursement.review_cases AS existing
      WHERE existing.receipt_id = receipt.id
        AND existing.status IN ('OPEN', 'CLAIMED')
    )
  ON CONFLICT (id) DO NOTHING
  RETURNING id, receipt_id
)
INSERT INTO reimbursement.review_case_audits (review_case_id, actor_id, action)
SELECT inserted.id, receipt.owner_id, 'REVIEW_CASE_BACKFILLED'
FROM inserted_cases AS inserted
JOIN reimbursement.receipts AS receipt ON receipt.id = inserted.receipt_id;

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.review_cases TO reimbursement_api;
GRANT SELECT, INSERT ON reimbursement.review_case_audits TO reimbursement_api;

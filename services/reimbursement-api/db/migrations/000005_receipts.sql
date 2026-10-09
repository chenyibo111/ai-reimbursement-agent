CREATE TABLE IF NOT EXISTS reimbursement.receipts (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES reimbursement.claims(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size BIGINT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT,
  status TEXT NOT NULL,
  invoice_number TEXT,
  ocr_confidence DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  CHECK (status IN ('UPLOAD_PENDING', 'READY_FOR_OCR', 'EXTRACTED', 'REVIEW_REQUIRED', 'QUARANTINED')),
  CHECK (expected_size > 0 AND expected_size <= 20971520)
);

CREATE UNIQUE INDEX IF NOT EXISTS receipts_content_hash_unique_idx
  ON reimbursement.receipts (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_invoice_number_idx
  ON reimbursement.receipts (invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS reimbursement.receipt_review_issues (
  id BIGSERIAL PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES reimbursement.receipts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  blocking BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reimbursement.receipt_audits (
  id BIGSERIAL PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES reimbursement.employees(id),
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.receipts TO reimbursement_api;
GRANT SELECT, INSERT ON reimbursement.receipt_review_issues TO reimbursement_api;
GRANT SELECT, INSERT ON reimbursement.receipt_audits TO reimbursement_api;
GRANT USAGE, SELECT ON SEQUENCE reimbursement.receipt_review_issues_id_seq TO reimbursement_api;
GRANT USAGE, SELECT ON SEQUENCE reimbursement.receipt_audits_id_seq TO reimbursement_api;

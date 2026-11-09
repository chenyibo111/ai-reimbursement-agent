ALTER TABLE reimbursement.receipts
  ADD COLUMN IF NOT EXISTS ocr_text TEXT NOT NULL DEFAULT ''
    CHECK (octet_length(ocr_text) <= 32000);

COMMENT ON COLUMN reimbursement.receipts.ocr_text IS 'Internal OCR text for bounded receipt classification; never returned by public receipt APIs.';

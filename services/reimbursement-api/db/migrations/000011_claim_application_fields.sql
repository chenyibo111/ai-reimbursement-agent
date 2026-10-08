ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS requested_amount_cent BIGINT CHECK (requested_amount_cent >= 0),
  ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  ADD COLUMN IF NOT EXISTS requested_amount_source TEXT NOT NULL DEFAULT 'OCR_SUGGESTED' CHECK (requested_amount_source IN ('OCR_SUGGESTED', 'MANUAL')),
  ADD COLUMN IF NOT EXISTS remark TEXT CHECK (char_length(remark) <= 1000);

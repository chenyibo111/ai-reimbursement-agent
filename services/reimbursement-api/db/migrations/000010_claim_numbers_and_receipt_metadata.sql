CREATE TABLE IF NOT EXISTS reimbursement.claim_number_counters (
  business_date DATE PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1)
);

CREATE OR REPLACE FUNCTION reimbursement.next_claim_number(at_time TIMESTAMPTZ DEFAULT now())
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  local_business_date DATE := (at_time AT TIME ZONE 'Asia/Shanghai')::DATE;
  next_sequence INTEGER;
BEGIN
  INSERT INTO reimbursement.claim_number_counters (business_date, last_sequence)
  VALUES (local_business_date, 1)
  ON CONFLICT (business_date) DO UPDATE
    SET last_sequence = reimbursement.claim_number_counters.last_sequence + 1
  RETURNING last_sequence INTO next_sequence;

  RETURN 'BX' || to_char(local_business_date, 'YYYYMMDD') || '-' || lpad(next_sequence::TEXT, 4, '0');
END;
$$;

ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS claim_number TEXT;

WITH numbered_claims AS (
  SELECT
    id,
    (created_at AT TIME ZONE 'Asia/Shanghai')::DATE AS business_date,
    row_number() OVER (
      PARTITION BY (created_at AT TIME ZONE 'Asia/Shanghai')::DATE
      ORDER BY created_at ASC, id ASC
    ) AS daily_sequence
  FROM reimbursement.claims
  WHERE claim_number IS NULL
)
UPDATE reimbursement.claims AS claim
SET claim_number = 'BX' || to_char(numbered_claims.business_date, 'YYYYMMDD') || '-' || lpad(numbered_claims.daily_sequence::TEXT, 4, '0')
FROM numbered_claims
WHERE claim.id = numbered_claims.id;

INSERT INTO reimbursement.claim_number_counters (business_date, last_sequence)
SELECT
  (created_at AT TIME ZONE 'Asia/Shanghai')::DATE,
  max(substring(claim_number FROM '[0-9]+$')::INTEGER)
FROM reimbursement.claims
GROUP BY (created_at AT TIME ZONE 'Asia/Shanghai')::DATE
ON CONFLICT (business_date) DO UPDATE
  SET last_sequence = GREATEST(
    reimbursement.claim_number_counters.last_sequence,
    EXCLUDED.last_sequence
  );

ALTER TABLE reimbursement.claims
  ALTER COLUMN claim_number SET DEFAULT reimbursement.next_claim_number(),
  ALTER COLUMN claim_number SET NOT NULL;

ALTER TABLE reimbursement.claims
  ADD CONSTRAINT claims_claim_number_key UNIQUE (claim_number);

ALTER TABLE reimbursement.receipts
  ADD COLUMN IF NOT EXISTS invoice_date DATE,
  ADD COLUMN IF NOT EXISTS total_amount_cent BIGINT CHECK (total_amount_cent >= 0),
  ADD COLUMN IF NOT EXISTS seller_name TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.claim_number_counters TO reimbursement_api;
GRANT EXECUTE ON FUNCTION reimbursement.next_claim_number(TIMESTAMPTZ) TO reimbursement_api;

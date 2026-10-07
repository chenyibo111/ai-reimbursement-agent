DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'reimbursement'
      AND table_name = 'idempotency_records'
      AND column_name = 'response_body'
      AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE reimbursement.idempotency_records
      ALTER COLUMN response_body TYPE TEXT
      USING response_body::text;
  END IF;
END
$$;

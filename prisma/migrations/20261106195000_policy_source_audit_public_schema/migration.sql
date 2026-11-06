DO $$
BEGIN
  IF to_regclass('reimbursement."PolicySourceAuditEvent"') IS NOT NULL
     AND to_regclass('public."PolicySourceAuditEvent"') IS NULL THEN
    ALTER TABLE reimbursement."PolicySourceAuditEvent" SET SCHEMA public;
  END IF;
END $$;

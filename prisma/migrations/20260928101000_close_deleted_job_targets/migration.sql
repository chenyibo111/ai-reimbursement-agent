ALTER TABLE "AsyncJob" DROP CONSTRAINT "AsyncJob_target_matches_kind";
ALTER TABLE "AsyncJob" ADD CONSTRAINT "AsyncJob_target_matches_kind" CHECK (
  "status" = 'CLOSED'
  OR ("kind" = 'RECEIPT_EXTRACTION' AND "claimId" IS NOT NULL AND "receiptId" IS NOT NULL AND "policySourceId" IS NULL)
  OR ("kind" = 'POLICY_SOURCE_SYNC' AND "claimId" IS NULL AND "receiptId" IS NULL AND "policySourceId" IS NOT NULL)
);

CREATE FUNCTION "close_async_jobs_for_deleted_receipt"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "AsyncJob"
  SET "status" = 'CLOSED', "failureCode" = 'TARGET_DELETED', "leaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "receiptId" = OLD."id" AND "status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'REVIEW_REQUIRED');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Receipt_close_async_jobs_before_delete"
BEFORE DELETE ON "Receipt"
FOR EACH ROW EXECUTE FUNCTION "close_async_jobs_for_deleted_receipt"();

CREATE FUNCTION "close_async_jobs_for_deleted_policy_source"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "AsyncJob"
  SET "status" = 'CLOSED', "failureCode" = 'TARGET_DELETED', "leaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "policySourceId" = OLD."id" AND "status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'REVIEW_REQUIRED');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PolicySource_close_async_jobs_before_delete"
BEFORE DELETE ON "PolicySource"
FOR EACH ROW EXECUTE FUNCTION "close_async_jobs_for_deleted_policy_source"();

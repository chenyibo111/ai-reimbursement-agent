CREATE OR REPLACE FUNCTION "close_async_jobs_for_deleted_receipt"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "AsyncJob"
  SET "status" = 'CLOSED', "failureCode" = 'TARGET_DELETED', "leaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "receiptId" = OLD."id" AND "status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'REVIEW_REQUIRED', 'SUCCEEDED');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "close_async_jobs_for_deleted_policy_source"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "AsyncJob"
  SET "status" = 'CLOSED', "failureCode" = 'TARGET_DELETED', "leaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "policySourceId" = OLD."id" AND "status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'REVIEW_REQUIRED', 'SUCCEEDED');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

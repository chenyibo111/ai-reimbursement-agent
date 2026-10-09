-- Agent conversation state can reference a claim owned by the Go reimbursement service.
-- Keep claimId indexed for correlation, but do not enforce a cross-service database FK.
ALTER TABLE "ReimbursementIntake"
DROP CONSTRAINT IF EXISTS "ReimbursementIntake_claimId_fkey";

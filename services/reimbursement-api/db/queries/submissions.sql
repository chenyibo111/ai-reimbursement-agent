-- name: FindSubmissionSnapshotByIdempotencyKey :one
SELECT claim_id, submission_number, claim_version, policy_version, submitted_at
FROM reimbursement.submission_snapshots
WHERE actor_id = $1 AND claim_id = $2 AND idempotency_key = $3;

-- Final submission locks reimbursement.claims, checks DRAFT and the expected
-- version, writes an immutable snapshot, then emits claim.submitted.v1.

-- name: FindOwnedClaim :one
SELECT id, owner_id, status, purpose, expense_category, participants, project_code,
       version, created_at, updated_at
FROM reimbursement.claims
WHERE id = $1 AND owner_id = $2;

-- name: UpdateDraftClaim :execrows
UPDATE reimbursement.claims
SET purpose = $4,
    expense_category = $5,
    participants = $6::jsonb,
    project_code = $7,
    version = $8,
    updated_at = now()
WHERE id = $1 AND owner_id = $2 AND status = 'DRAFT' AND version = $3;

-- All Create/Update/Delete operations append claim_audits and outbox_events
-- inside the same pgx transaction as the aggregate write.

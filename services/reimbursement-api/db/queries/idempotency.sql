-- name: GetIdempotencyRecordForUpdate :one
SELECT actor_id, operation, idempotency_key, request_hash, status_code, response_body, completed_at
FROM reimbursement.idempotency_records
WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
FOR UPDATE;

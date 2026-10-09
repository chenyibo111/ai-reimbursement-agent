-- name: FindOwnedReceipt :one
SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
       content_hash, status, invoice_number, ocr_confidence, created_at, updated_at
FROM reimbursement.receipts
WHERE id = $1 AND claim_id = $2 AND owner_id = $3;

-- Receipt mutations append receipt_audits and reimbursement.outbox_events
-- in the same transaction so workers and finance review receive a trace.

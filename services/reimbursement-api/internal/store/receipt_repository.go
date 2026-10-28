package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresReceiptRepository struct{ pool *pgxpool.Pool }

func NewPostgresReceiptRepository(pool *pgxpool.Pool) *PostgresReceiptRepository {
	return &PostgresReceiptRepository{pool: pool}
}

func (repository *PostgresReceiptRepository) Create(ctx context.Context, receipt domain.Receipt) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin receipt creation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status domain.ClaimStatus
	if err = tx.QueryRow(ctx, `SELECT status FROM reimbursement.claims WHERE id = $1 AND owner_id = $2 FOR UPDATE`, receipt.ClaimID, receipt.OwnerID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ErrClaimNotFound
		}
		return fmt.Errorf("lock claim for receipt creation: %w", err)
	}
	if status != domain.ClaimStatusDraft {
		return domain.ErrClaimNotDraft
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO reimbursement.receipts (id, claim_id, owner_id, filename, content_type, expected_size, object_key, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`, receipt.ID, receipt.ClaimID, receipt.OwnerID, receipt.Filename, receipt.ContentType, receipt.ExpectedSize, receipt.ObjectKey, receipt.Status, receipt.CreatedAt, receipt.UpdatedAt); err != nil {
		return fmt.Errorf("insert receipt: %w", err)
	}
	if err = writeReceiptAuditAndEvent(ctx, tx, receipt.ID, receipt.ClaimID, receipt.OwnerID, "RECEIPT_UPLOAD_SESSION_CREATED", "ReceiptUploadSessionCreated"); err != nil {
		return err
	}
	if err = advanceClaimVersionForReceipt(ctx, tx, receipt.ClaimID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit receipt creation: %w", err)
	}
	return nil
}

func (repository *PostgresReceiptRepository) FindOwned(ctx context.Context, receiptID string, claimID string, actorID string) (domain.Receipt, error) {
	return scanReceipt(repository.pool.QueryRow(ctx, `
		SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
		       content_hash, status, invoice_number, invoice_date, total_amount_cent, seller_name, ocr_confidence, created_at, updated_at
		FROM reimbursement.receipts
		WHERE id = $1 AND claim_id = $2 AND owner_id = $3
	`, receiptID, claimID, actorID))
}

func (repository *PostgresReceiptRepository) ListOwnedByClaim(ctx context.Context, claimID string, actorID string) ([]domain.Receipt, error) {
	rows, err := repository.pool.Query(ctx, `
		SELECT receipt.id, receipt.claim_id, receipt.owner_id, receipt.filename, receipt.content_type, receipt.expected_size, receipt.object_key,
		       receipt.content_hash, receipt.status, receipt.invoice_number, receipt.invoice_date, receipt.total_amount_cent, receipt.seller_name, receipt.ocr_confidence, receipt.created_at, receipt.updated_at,
		       EXISTS (
		         SELECT 1
		         FROM reimbursement.review_cases AS review_case
		         WHERE review_case.receipt_id = receipt.id AND review_case.status = 'CLOSED'
		       ) AS closed_by_review
		FROM reimbursement.receipts AS receipt
		WHERE receipt.claim_id = $1 AND receipt.owner_id = $2
		ORDER BY receipt.created_at ASC, receipt.id ASC
	`, claimID, actorID)
	if err != nil {
		return nil, fmt.Errorf("query owned receipts: %w", err)
	}
	defer rows.Close()
	receipts := make([]domain.Receipt, 0)
	for rows.Next() {
		receipt, scanErr := scanReceiptWithReviewClosure(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		receipts = append(receipts, receipt)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate owned receipts: %w", err)
	}
	return receipts, nil
}

// FindByID is reserved for trusted asynchronous workers. HTTP handlers must
// use FindOwned so a client cannot discover another employee's receipt.
func (repository *PostgresReceiptRepository) FindByID(ctx context.Context, receiptID string) (domain.Receipt, error) {
	return scanReceipt(repository.pool.QueryRow(ctx, `
		SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
		       content_hash, status, invoice_number, invoice_date, total_amount_cent, seller_name, ocr_confidence, created_at, updated_at
		FROM reimbursement.receipts
		WHERE id = $1
	`, receiptID))
}

func (repository *PostgresReceiptRepository) FindByContentHash(ctx context.Context, hash string) (domain.Receipt, error) {
	return scanReceipt(repository.pool.QueryRow(ctx, `
		SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
		       content_hash, status, invoice_number, invoice_date, total_amount_cent, seller_name, ocr_confidence, created_at, updated_at
		FROM reimbursement.receipts
		WHERE content_hash = $1
	`, hash))
}

func (repository *PostgresReceiptRepository) DeleteOwned(ctx context.Context, receiptID string, claimID string, actorID string, expectedVersion int64) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin receipt deletion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status domain.ClaimStatus
	var version int64
	if err = tx.QueryRow(ctx, `SELECT status, version FROM reimbursement.claims WHERE id = $1 AND owner_id = $2 FOR UPDATE`, claimID, actorID).Scan(&status, &version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ErrClaimNotFound
		}
		return fmt.Errorf("lock claim for receipt deletion: %w", err)
	}
	if status != domain.ClaimStatusDraft {
		return domain.ErrClaimNotDraft
	}
	if version != expectedVersion {
		return domain.ErrClaimVersionConflict
	}

	receipt, err := scanReceipt(tx.QueryRow(ctx, `
		SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
		       content_hash, status, invoice_number, invoice_date, total_amount_cent, seller_name, ocr_confidence, created_at, updated_at
		FROM reimbursement.receipts
		WHERE id = $1 AND claim_id = $2 AND owner_id = $3
		FOR UPDATE
	`, receiptID, claimID, actorID))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.object_cleanup_jobs (object_key) VALUES ($1) ON CONFLICT (object_key) DO NOTHING`, receipt.ObjectKey); err != nil {
		return fmt.Errorf("queue receipt object cleanup: %w", err)
	}
	if err = writeReceiptAuditAndEvent(ctx, tx, receiptID, claimID, actorID, "RECEIPT_DELETED", "ReceiptDeleted"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		WITH closed AS (
			UPDATE reimbursement.review_cases
			SET receipt_id = NULL,
			    status = CASE WHEN status IN ('OPEN', 'CLAIMED') THEN 'CLOSED' ELSE status END,
			    resolution = CASE WHEN status IN ('OPEN', 'CLAIMED') THEN 'RECEIPT_DELETED' ELSE resolution END,
			    resolved_by = CASE WHEN status IN ('OPEN', 'CLAIMED') THEN $2 ELSE resolved_by END,
			    resolved_at = CASE WHEN status IN ('OPEN', 'CLAIMED') THEN now() ELSE resolved_at END,
			    updated_at = now(), version = version + 1
			WHERE receipt_id = $1
			RETURNING id
		)
		INSERT INTO reimbursement.review_case_audits (review_case_id, actor_id, action)
		SELECT id, $2, 'RECEIPT_DELETED_BY_EMPLOYEE' FROM closed
	`, receiptID, actorID); err != nil {
		return fmt.Errorf("close receipt review cases: %w", err)
	}
	result, err := tx.Exec(ctx, `DELETE FROM reimbursement.receipts WHERE id = $1 AND claim_id = $2 AND owner_id = $3`, receiptID, claimID, actorID)
	if err != nil {
		return fmt.Errorf("delete receipt: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ErrReceiptNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.claims SET version = version + 1, updated_at = now() WHERE id = $1`, claimID); err != nil {
		return fmt.Errorf("advance claim version after receipt deletion: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit receipt deletion: %w", err)
	}
	return nil
}

func (repository *PostgresReceiptRepository) MarkReadyForOCR(ctx context.Context, receiptID string, hash string) error {
	return repository.withReceiptMutation(ctx, receiptID, "RECEIPT_READY_FOR_OCR", "ReceiptReadyForOCR", func(tx pgx.Tx) (string, string, error) {
		result, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET content_hash = $2, status = 'READY_FOR_OCR', updated_at = now() WHERE id = $1`, receiptID, hash)
		if err != nil {
			var pgError *pgconn.PgError
			if errors.As(err, &pgError) && pgError.Code == "23505" {
				return "", "", application.ErrDuplicateReceiptContent
			}
			return "", "", err
		}
		if result.RowsAffected() != 1 {
			return "", "", application.ErrReceiptNotFound
		}
		return receiptActorAndClaim(ctx, tx, receiptID)
	})
}

func (repository *PostgresReceiptRepository) MarkReviewRequired(ctx context.Context, receiptID string, reason string) error {
	return repository.TransitionToReview(ctx, receiptID, reason, nil)
}

// TransitionToReview records a finance-reviewable OCR anomaly as one atomic
// state change. Repeated deliveries may add receipt audit/event history, but
// cannot duplicate either the issue code or the active finance case.
func (repository *PostgresReceiptRepository) TransitionToReview(ctx context.Context, receiptID string, reason string, ocrResult *application.OCRResult) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin receipt review transition: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actorID, claimID, err := lockDraftClaimForReceipt(ctx, tx, receiptID)
	if err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT owner_id, claim_id FROM reimbursement.receipts WHERE id = $1 FOR UPDATE`, receiptID).Scan(&actorID, &claimID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ErrReceiptNotFound
		}
		return fmt.Errorf("lock receipt for review transition: %w", err)
	}

	if ocrResult == nil {
		if _, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET status = 'REVIEW_REQUIRED', updated_at = now() WHERE id = $1`, receiptID); err != nil {
			return fmt.Errorf("mark receipt review required: %w", err)
		}
	} else if _, err := tx.Exec(ctx, `
		UPDATE reimbursement.receipts
		SET invoice_number = NULLIF($2, ''), invoice_date = $3, total_amount_cent = $4,
		    seller_name = NULLIF($5::text, ''), ocr_confidence = $6, status = 'REVIEW_REQUIRED', updated_at = now()
		WHERE id = $1
	`, receiptID, ocrResult.InvoiceNumber, ocrResult.InvoiceDate, ocrResult.TotalAmountCent, ocrResult.SellerName, ocrResult.Confidence); err != nil {
		return fmt.Errorf("persist reviewable OCR candidate: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO reimbursement.receipt_review_issues (receipt_id, code)
		VALUES ($1, $2)
		ON CONFLICT (receipt_id, code) DO NOTHING
	`, receiptID, reason); err != nil {
		return fmt.Errorf("record receipt review issue: %w", err)
	}

	var reviewCaseID string
	err = tx.QueryRow(ctx, `
		INSERT INTO reimbursement.review_cases (id, claim_id, receipt_id, kind, reason_code, status)
		VALUES ($1, $2, $3, 'RECEIPT_OCR', $4, 'OPEN')
		ON CONFLICT (receipt_id) WHERE receipt_id IS NOT NULL AND status IN ('OPEN', 'CLAIMED') DO NOTHING
		RETURNING id
	`, "receipt-review-"+randomUUID(), claimID, receiptID, reason).Scan(&reviewCaseID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("create receipt review case: %w", err)
	}
	if reviewCaseID != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO reimbursement.review_case_audits (review_case_id, actor_id, action) VALUES ($1, $2, 'REVIEW_CASE_CREATED')`, reviewCaseID, actorID); err != nil {
			return fmt.Errorf("audit receipt review case creation: %w", err)
		}
	}
	if err := writeReceiptAuditAndEvent(ctx, tx, receiptID, claimID, actorID, "RECEIPT_REVIEW_REQUIRED", "ReceiptReviewRequired"); err != nil {
		return err
	}
	if err := advanceClaimVersionForReceipt(ctx, tx, claimID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit receipt review transition: %w", err)
	}
	return nil
}

func (repository *PostgresReceiptRepository) MarkQuarantined(ctx context.Context, receiptID string) error {
	return repository.withReceiptMutation(ctx, receiptID, "RECEIPT_QUARANTINED", "ReceiptQuarantined", func(tx pgx.Tx) (string, string, error) {
		result, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET status = 'QUARANTINED', updated_at = now() WHERE id = $1`, receiptID)
		if err != nil {
			return "", "", err
		}
		if result.RowsAffected() != 1 {
			return "", "", application.ErrReceiptNotFound
		}
		return receiptActorAndClaim(ctx, tx, receiptID)
	})
}

func (repository *PostgresReceiptRepository) MarkExtracted(ctx context.Context, receiptID string, result application.OCRResult) error {
	return repository.withReceiptMutation(ctx, receiptID, "RECEIPT_OCR_EXTRACTED", "ReceiptExtractionCompleted", func(tx pgx.Tx) (string, string, error) {
		update, err := tx.Exec(ctx, `
			UPDATE reimbursement.receipts
			SET invoice_number = NULLIF($2, ''), invoice_date = $3, total_amount_cent = $4,
			    seller_name = NULLIF($5::text, ''), ocr_confidence = $6, status = 'EXTRACTED', updated_at = now()
			WHERE id = $1
		`, receiptID, result.InvoiceNumber, result.InvoiceDate, result.TotalAmountCent, result.SellerName, result.Confidence)
		if err != nil {
			return "", "", err
		}
		if update.RowsAffected() != 1 {
			return "", "", application.ErrReceiptNotFound
		}
		return receiptActorAndClaim(ctx, tx, receiptID)
	})
}

func (repository *PostgresReceiptRepository) HasSubmittedInvoice(ctx context.Context, invoiceNumber string) (bool, error) {
	var exists bool
	err := repository.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM reimbursement.receipts receipt
			JOIN reimbursement.claims claim ON claim.id = receipt.claim_id
			WHERE receipt.invoice_number = $1 AND claim.status = 'SUBMITTED'
		)
	`, invoiceNumber).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("query submitted invoice: %w", err)
	}
	return exists, nil
}

func (repository *PostgresReceiptRepository) withReceiptMutation(ctx context.Context, receiptID string, action string, eventType string, mutate func(pgx.Tx) (string, string, error)) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin receipt mutation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedActor, lockedClaim, err := lockDraftClaimForReceipt(ctx, tx, receiptID)
	if err != nil {
		return err
	}
	actorID, claimID, err := mutate(tx)
	if err != nil {
		return err
	}
	if actorID != lockedActor || claimID != lockedClaim {
		return application.ErrReceiptNotFound
	}
	if err = writeReceiptAuditAndEvent(ctx, tx, receiptID, claimID, actorID, action, eventType); err != nil {
		return err
	}
	if err = advanceClaimVersionForReceipt(ctx, tx, claimID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit receipt mutation: %w", err)
	}
	return nil
}

func lockDraftClaimForReceipt(ctx context.Context, tx pgx.Tx, receiptID string) (string, string, error) {
	var actorID, claimID string
	var status domain.ClaimStatus
	err := tx.QueryRow(ctx, `
		SELECT receipt.owner_id, receipt.claim_id, claim.status
		FROM reimbursement.receipts AS receipt
		JOIN reimbursement.claims AS claim ON claim.id = receipt.claim_id AND claim.owner_id = receipt.owner_id
		WHERE receipt.id = $1
		FOR UPDATE OF claim
	`, receiptID).Scan(&actorID, &claimID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", application.ErrReceiptNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("lock claim for receipt mutation: %w", err)
	}
	if status != domain.ClaimStatusDraft {
		return "", "", domain.ErrClaimNotDraft
	}
	return actorID, claimID, nil
}

func advanceClaimVersionForReceipt(ctx context.Context, tx pgx.Tx, claimID string) error {
	if _, err := tx.Exec(ctx, `UPDATE reimbursement.claims SET version = version + 1, updated_at = now() WHERE id = $1`, claimID); err != nil {
		return fmt.Errorf("advance claim version after receipt mutation: %w", err)
	}
	return nil
}

func receiptActorAndClaim(ctx context.Context, tx pgx.Tx, receiptID string) (string, string, error) {
	var actorID string
	var claimID string
	err := tx.QueryRow(ctx, `SELECT owner_id, claim_id FROM reimbursement.receipts WHERE id = $1`, receiptID).Scan(&actorID, &claimID)
	return actorID, claimID, err
}

func writeReceiptAuditAndEvent(ctx context.Context, tx pgx.Tx, receiptID string, claimID string, actorID string, action string, eventType string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO reimbursement.receipt_audits (receipt_id, actor_id, action) VALUES ($1, $2, $3)`, receiptID, actorID, action); err != nil {
		return fmt.Errorf("insert receipt audit: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO reimbursement.outbox_events (event_id, event_type, aggregate_id, payload)
		VALUES ($1::uuid, $2, $3::text, jsonb_build_object('receiptId', $3::text, 'claimId', $4::text))
	`, randomUUID(), eventType, receiptID, claimID); err != nil {
		return fmt.Errorf("insert receipt outbox event: %w", err)
	}
	return nil
}

type receiptRow interface{ Scan(...any) error }

func scanReceipt(row receiptRow) (domain.Receipt, error) {
	return scanReceiptWithOptionalReviewClosure(row, nil)
}

func scanReceiptWithReviewClosure(row receiptRow) (domain.Receipt, error) {
	closedByReview := false
	return scanReceiptWithOptionalReviewClosure(row, &closedByReview)
}

func scanReceiptWithOptionalReviewClosure(row receiptRow, closedByReview *bool) (domain.Receipt, error) {
	var receipt domain.Receipt
	var contentHash *string
	var invoiceNumber *string
	var invoiceDate *time.Time
	var totalAmountCent *int64
	var sellerName *string
	var confidence *float64
	targets := []any{&receipt.ID, &receipt.ClaimID, &receipt.OwnerID, &receipt.Filename, &receipt.ContentType, &receipt.ExpectedSize, &receipt.ObjectKey, &contentHash, &receipt.Status, &invoiceNumber, &invoiceDate, &totalAmountCent, &sellerName, &confidence, &receipt.CreatedAt, &receipt.UpdatedAt}
	if closedByReview != nil {
		targets = append(targets, closedByReview)
	}
	err := row.Scan(targets...)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Receipt{}, application.ErrReceiptNotFound
	}
	if err != nil {
		return domain.Receipt{}, fmt.Errorf("scan receipt: %w", err)
	}
	if contentHash != nil {
		receipt.ContentHash = *contentHash
	}
	if invoiceNumber != nil {
		receipt.InvoiceNumber = *invoiceNumber
	}
	receipt.InvoiceDate = invoiceDate
	receipt.TotalAmountCent = totalAmountCent
	receipt.SellerName = sellerName
	if confidence != nil {
		receipt.OCRConfidence = *confidence
	}
	if closedByReview != nil {
		receipt.ClosedByReview = *closedByReview
	}
	return receipt, nil
}

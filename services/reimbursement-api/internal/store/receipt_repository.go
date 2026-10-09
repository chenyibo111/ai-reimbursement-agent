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
	if _, err = tx.Exec(ctx, `
		INSERT INTO reimbursement.receipts (id, claim_id, owner_id, filename, content_type, expected_size, object_key, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`, receipt.ID, receipt.ClaimID, receipt.OwnerID, receipt.Filename, receipt.ContentType, receipt.ExpectedSize, receipt.ObjectKey, receipt.Status, receipt.CreatedAt, receipt.UpdatedAt); err != nil {
		return fmt.Errorf("insert receipt: %w", err)
	}
	if err = writeReceiptAuditAndEvent(ctx, tx, receipt.ID, receipt.ClaimID, receipt.OwnerID, "RECEIPT_UPLOAD_SESSION_CREATED", "ReceiptUploadSessionCreated"); err != nil {
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
		SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
		       content_hash, status, invoice_number, invoice_date, total_amount_cent, seller_name, ocr_confidence, created_at, updated_at
		FROM reimbursement.receipts
		WHERE claim_id = $1 AND owner_id = $2
		ORDER BY created_at ASC, id ASC
	`, claimID, actorID)
	if err != nil {
		return nil, fmt.Errorf("query owned receipts: %w", err)
	}
	defer rows.Close()
	receipts := make([]domain.Receipt, 0)
	for rows.Next() {
		receipt, scanErr := scanReceipt(rows)
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

func (repository *PostgresReceiptRepository) DeleteOwned(ctx context.Context, receiptID string, claimID string, actorID string) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin receipt deletion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status domain.ClaimStatus
	if err = tx.QueryRow(ctx, `SELECT status FROM reimbursement.claims WHERE id = $1 AND owner_id = $2 FOR UPDATE`, claimID, actorID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ErrClaimNotFound
		}
		return fmt.Errorf("lock claim for receipt deletion: %w", err)
	}
	if status != domain.ClaimStatusDraft {
		return domain.ErrClaimNotDraft
	}

	if _, err = scanReceipt(tx.QueryRow(ctx, `
		SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key,
		       content_hash, status, invoice_number, invoice_date, total_amount_cent, seller_name, ocr_confidence, created_at, updated_at
		FROM reimbursement.receipts
		WHERE id = $1 AND claim_id = $2 AND owner_id = $3
		FOR UPDATE
	`, receiptID, claimID, actorID)); err != nil {
		return err
	}
	if err = writeReceiptAuditAndEvent(ctx, tx, receiptID, claimID, actorID, "RECEIPT_DELETED", "ReceiptDeleted"); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `DELETE FROM reimbursement.receipts WHERE id = $1 AND claim_id = $2 AND owner_id = $3`, receiptID, claimID, actorID)
	if err != nil {
		return fmt.Errorf("delete receipt: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ErrReceiptNotFound
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
	return repository.withReceiptMutation(ctx, receiptID, "RECEIPT_REVIEW_REQUIRED", "ReceiptReviewRequired", func(tx pgx.Tx) (string, string, error) {
		result, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET status = 'REVIEW_REQUIRED', updated_at = now() WHERE id = $1`, receiptID)
		if err != nil {
			return "", "", err
		}
		if result.RowsAffected() != 1 {
			return "", "", application.ErrReceiptNotFound
		}
		if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.receipt_review_issues (receipt_id, code) VALUES ($1, $2)`, receiptID, reason); err != nil {
			return "", "", err
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
	actorID, claimID, err := mutate(tx)
	if err != nil {
		return err
	}
	if err = writeReceiptAuditAndEvent(ctx, tx, receiptID, claimID, actorID, action, eventType); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit receipt mutation: %w", err)
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
	var receipt domain.Receipt
	var contentHash *string
	var invoiceNumber *string
	var invoiceDate *time.Time
	var totalAmountCent *int64
	var sellerName *string
	var confidence *float64
	err := row.Scan(&receipt.ID, &receipt.ClaimID, &receipt.OwnerID, &receipt.Filename, &receipt.ContentType, &receipt.ExpectedSize, &receipt.ObjectKey, &contentHash, &receipt.Status, &invoiceNumber, &invoiceDate, &totalAmountCent, &sellerName, &confidence, &receipt.CreatedAt, &receipt.UpdatedAt)
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
	return receipt, nil
}

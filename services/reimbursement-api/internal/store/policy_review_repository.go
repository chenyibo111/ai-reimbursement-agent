package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresPolicyRuleRepository struct{ pool *pgxpool.Pool }

func NewPostgresPolicyRuleRepository(pool *pgxpool.Pool) *PostgresPolicyRuleRepository {
	return &PostgresPolicyRuleRepository{pool}
}
func (repository *PostgresPolicyRuleRepository) Publish(ctx context.Context, actorID string, version application.PolicyVersion) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.policy_versions SET status='ARCHIVED' WHERE status='PUBLISHED'`); err != nil {
		return fmt.Errorf("archive policy: %w", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.policy_versions (id,status,effective_date,published_by,published_at) VALUES ($1,'PUBLISHED',$2::date,$3,now()) ON CONFLICT (id) DO UPDATE SET status='PUBLISHED',effective_date=EXCLUDED.effective_date,published_by=EXCLUDED.published_by,published_at=EXCLUDED.published_at`, version.ID, version.EffectiveDate, actorID); err != nil {
		return fmt.Errorf("publish policy: %w", err)
	}
	return tx.Commit(ctx)
}

type PostgresReviewCaseRepository struct{ pool *pgxpool.Pool }

func NewPostgresReviewCaseRepository(pool *pgxpool.Pool) *PostgresReviewCaseRepository {
	return &PostgresReviewCaseRepository{pool}
}

func (repository *PostgresReviewCaseRepository) ListReceiptCases(ctx context.Context) ([]application.ReviewCase, error) {
	rows, err := repository.pool.Query(ctx, reviewCaseSelect+`
		WHERE review_case.receipt_id IS NOT NULL
		ORDER BY CASE review_case.status WHEN 'OPEN' THEN 0 WHEN 'CLAIMED' THEN 1 ELSE 2 END, review_case.created_at ASC, review_case.id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list receipt review cases: %w", err)
	}
	defer rows.Close()
	cases := make([]application.ReviewCase, 0)
	for rows.Next() {
		reviewCase, err := scanReviewCase(rows)
		if err != nil {
			return nil, err
		}
		cases = append(cases, reviewCase)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate receipt review cases: %w", err)
	}
	return cases, nil
}

func (repository *PostgresReviewCaseRepository) GetReceiptCase(ctx context.Context, caseID string) (application.ReviewCase, error) {
	reviewCase, err := scanReviewCase(repository.pool.QueryRow(ctx, reviewCaseSelect+` WHERE review_case.id = $1 AND review_case.receipt_id IS NOT NULL`, caseID))
	if err == pgx.ErrNoRows {
		return application.ReviewCase{}, application.ErrReviewCaseNotFound
	}
	if err != nil {
		return application.ReviewCase{}, fmt.Errorf("get receipt review case: %w", err)
	}
	return reviewCase, nil
}

func (repository *PostgresReviewCaseRepository) ClaimReceiptCase(ctx context.Context, actorID, caseID string, expectedVersion int64) (application.ReviewCase, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return application.ReviewCase{}, fmt.Errorf("begin review case claim: %w", err)
	}
	defer tx.Rollback(ctx)

	result, err := tx.Exec(ctx, `
		UPDATE reimbursement.review_cases AS review_case
		SET status = 'CLAIMED', assigned_to = $2, claimed_at = now(), updated_at = now(), version = version + 1
		WHERE review_case.id = $1
		  AND review_case.receipt_id IS NOT NULL
		  AND review_case.status = 'OPEN'
		  AND review_case.version = $3
	`, caseID, actorID, expectedVersion)
	if err != nil {
		return application.ReviewCase{}, fmt.Errorf("claim receipt review case: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ReviewCase{}, application.ErrReviewCaseConflict
	}
	if _, err := tx.Exec(ctx, `INSERT INTO reimbursement.review_case_audits (review_case_id, actor_id, action) VALUES ($1, $2, 'REVIEW_CASE_CLAIMED')`, caseID, actorID); err != nil {
		return application.ReviewCase{}, fmt.Errorf("audit receipt review claim: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return application.ReviewCase{}, fmt.Errorf("commit review case claim: %w", err)
	}
	return repository.GetReceiptCase(ctx, caseID)
}

func (repository *PostgresReviewCaseRepository) ResolveReceiptCase(ctx context.Context, actorID string, command application.ResolveReceiptCaseCommand, administratorTakeover bool) (application.ReviewCase, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return application.ReviewCase{}, fmt.Errorf("begin review case resolution: %w", err)
	}
	defer tx.Rollback(ctx)

	var targetReceiptID string
	if err := tx.QueryRow(ctx, `SELECT receipt_id FROM reimbursement.review_cases WHERE id = $1 AND receipt_id IS NOT NULL`, command.CaseID).Scan(&targetReceiptID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ReviewCase{}, application.ErrReviewCaseConflict
		}
		return application.ReviewCase{}, fmt.Errorf("find review receipt: %w", err)
	}
	_, lockedClaimID, err := lockDraftClaimForReceipt(ctx, tx, targetReceiptID)
	if err != nil {
		return application.ReviewCase{}, err
	}
	var receiptID, claimID, currentInvoice string
	if err := tx.QueryRow(ctx, `
		SELECT review_case.receipt_id, review_case.claim_id, COALESCE(receipt.invoice_number, '')
		FROM reimbursement.review_cases AS review_case
		JOIN reimbursement.receipts AS receipt ON receipt.id = review_case.receipt_id
		WHERE review_case.id = $1 AND review_case.status = 'CLAIMED' AND review_case.version = $2
		  AND ($3::boolean OR review_case.assigned_to = $4)
		FOR UPDATE OF review_case, receipt
	`, command.CaseID, command.ExpectedVersion, administratorTakeover, actorID).Scan(&receiptID, &claimID, &currentInvoice); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ReviewCase{}, application.ErrReviewCaseConflict
		}
		return application.ReviewCase{}, fmt.Errorf("lock receipt review case: %w", err)
	}
	if receiptID != targetReceiptID || claimID != lockedClaimID {
		return application.ReviewCase{}, application.ErrReviewCaseConflict
	}

	invoiceNumber := currentInvoice
	if command.Action == application.ReviewCaseActionCorrectFields {
		invoiceNumber = command.InvoiceNumber
	}
	if invoiceNumber != "" && (command.Action == application.ReviewCaseActionConfirm || command.Action == application.ReviewCaseActionCorrectFields) {
		var duplicate bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM reimbursement.receipts AS candidate JOIN reimbursement.claims AS claim ON claim.id = candidate.claim_id WHERE candidate.invoice_number = $1 AND candidate.id <> $2 AND claim.status = 'SUBMITTED')`, invoiceNumber, receiptID).Scan(&duplicate); err != nil {
			return application.ReviewCase{}, fmt.Errorf("recheck submitted invoice: %w", err)
		}
		if duplicate {
			return application.ReviewCase{}, application.ErrDuplicateSubmittedInvoice
		}
	}

	if command.Action == application.ReviewCaseActionCorrectFields {
		if _, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET invoice_number = NULLIF($2, ''), invoice_date = $3, total_amount_cent = $4, seller_name = NULLIF($5::text, ''), status = 'EXTRACTED', updated_at = now() WHERE id = $1`, receiptID, command.InvoiceNumber, command.InvoiceDate, command.TotalAmountCent, command.SellerName); err != nil {
			return application.ReviewCase{}, fmt.Errorf("correct receipt fields: %w", err)
		}
	} else if command.Action == application.ReviewCaseActionConfirm {
		if _, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET status = 'EXTRACTED', updated_at = now() WHERE id = $1`, receiptID); err != nil {
			return application.ReviewCase{}, fmt.Errorf("confirm receipt extraction: %w", err)
		}
	} else if _, err := tx.Exec(ctx, `UPDATE reimbursement.receipts SET status = 'QUARANTINED', updated_at = now() WHERE id = $1`, receiptID); err != nil {
		return application.ReviewCase{}, fmt.Errorf("quarantine reviewed receipt: %w", err)
	}

	status := "RESOLVED"
	if command.Action == application.ReviewCaseActionRequestReupload || command.Action == application.ReviewCaseActionCloseInvalid {
		status = "CLOSED"
	}
	result, err := tx.Exec(ctx, `
		UPDATE reimbursement.review_cases AS review_case
		SET status = $3, resolution = $4, resolved_by = $2, resolved_at = now(), updated_at = now(), version = version + 1
		WHERE review_case.id = $1
		  AND review_case.receipt_id IS NOT NULL
		  AND review_case.status = 'CLAIMED'
		  AND review_case.version = $5
		  AND ($6::boolean OR review_case.assigned_to = $2)
	`, command.CaseID, actorID, status, command.Resolution, command.ExpectedVersion, administratorTakeover)
	if err != nil {
		return application.ReviewCase{}, fmt.Errorf("resolve receipt review case: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ReviewCase{}, application.ErrReviewCaseConflict
	}
	if _, err := tx.Exec(ctx, `INSERT INTO reimbursement.review_case_audits (review_case_id, actor_id, action) VALUES ($1, $2, $3)`, command.CaseID, actorID, "REVIEW_CASE_"+string(command.Action)); err != nil {
		return application.ReviewCase{}, fmt.Errorf("audit receipt review resolution: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO reimbursement.outbox_events (event_id, event_type, aggregate_id, payload)
		VALUES ($1::uuid, 'ReceiptReviewResolved', $2::text, jsonb_build_object('receiptId', $2::text, 'claimId', $3::text))
	`, randomUUID(), receiptID, claimID); err != nil {
		return application.ReviewCase{}, fmt.Errorf("insert receipt review resolution event: %w", err)
	}
	if err := advanceClaimVersionForReceipt(ctx, tx, claimID); err != nil {
		return application.ReviewCase{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return application.ReviewCase{}, fmt.Errorf("commit review case resolution: %w", err)
	}
	return repository.GetReceiptCase(ctx, command.CaseID)
}

const reviewCaseSelect = `
	SELECT review_case.id, review_case.claim_id, review_case.receipt_id, review_case.kind, review_case.reason_code,
	  review_case.status, review_case.assigned_to, review_case.claimed_at, review_case.resolution, review_case.resolved_by,
	  review_case.created_at, review_case.resolved_at, review_case.updated_at, review_case.version,
	  COALESCE(claim.claim_number, ''), COALESCE(claim.purpose, ''), COALESCE(assignee.display_name, '')
	FROM reimbursement.review_cases AS review_case
	LEFT JOIN reimbursement.claims AS claim ON claim.id = review_case.claim_id
	LEFT JOIN reimbursement.employees AS assignee ON assignee.id = review_case.assigned_to`

type reviewCaseScanner interface {
	Scan(...any) error
}

func scanReviewCase(row reviewCaseScanner) (application.ReviewCase, error) {
	var reviewCase application.ReviewCase
	var receiptID, reasonCode, assignedTo, resolution, resolvedBy *string
	var claimedAt, resolvedAt *time.Time
	err := row.Scan(
		&reviewCase.ID,
		&reviewCase.ClaimID,
		&receiptID,
		&reviewCase.Kind,
		&reasonCode,
		&reviewCase.Status,
		&assignedTo,
		&claimedAt,
		&resolution,
		&resolvedBy,
		&reviewCase.CreatedAt,
		&resolvedAt,
		&reviewCase.UpdatedAt,
		&reviewCase.Version,
		&reviewCase.ClaimNumber,
		&reviewCase.ClaimPurpose,
		&reviewCase.AssignedToDisplayName,
	)
	if err != nil {
		return application.ReviewCase{}, err
	}
	if receiptID != nil {
		reviewCase.ReceiptID = *receiptID
	}
	if reasonCode != nil {
		reviewCase.ReasonCode = *reasonCode
	}
	if assignedTo != nil {
		reviewCase.AssignedTo = *assignedTo
	}
	if resolution != nil {
		reviewCase.Resolution = *resolution
	}
	if resolvedBy != nil {
		reviewCase.ResolvedBy = *resolvedBy
	}
	reviewCase.ClaimedAt = claimedAt
	reviewCase.ResolvedAt = resolvedAt
	return reviewCase, nil
}

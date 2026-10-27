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

type PostgresClaimProgressRepository struct{ pool *pgxpool.Pool }

func NewPostgresClaimProgressRepository(pool *pgxpool.Pool) *PostgresClaimProgressRepository {
	return &PostgresClaimProgressRepository{pool: pool}
}

func (repository *PostgresClaimProgressRepository) LoadOwnedProgress(ctx context.Context, actorID, claimID string) (application.ClaimProgress, error) {
	var progress application.ClaimProgress
	var submittedAt *time.Time
	err := repository.pool.QueryRow(ctx, `
		SELECT id, claim_number, status, version, submission_number, submitted_at
		FROM reimbursement.claims WHERE id=$1 AND owner_id=$2
	`, claimID, actorID).Scan(&progress.ClaimID, &progress.ClaimNumber, &progress.Status, &progress.Version, &progress.SubmissionNumber, &submittedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ClaimProgress{}, application.ErrClaimNotFound
	}
	if err != nil {
		return application.ClaimProgress{}, fmt.Errorf("load owned claim progress: %w", err)
	}
	if submittedAt != nil {
		value := submittedAt.UTC().Format(time.RFC3339)
		progress.SubmittedAt = &value
	}
	rows, err := repository.pool.Query(ctx, `
		SELECT receipt.id, receipt.filename, receipt.status,
			COALESCE(review_case.status, '')
		FROM reimbursement.receipts AS receipt
		LEFT JOIN LATERAL (
			SELECT status FROM reimbursement.review_cases
			WHERE receipt_id=receipt.id AND claim_id=$1
			ORDER BY created_at DESC, id DESC LIMIT 1
		) AS review_case ON true
		WHERE receipt.claim_id=$1 AND receipt.owner_id=$2
		ORDER BY receipt.created_at ASC, receipt.id ASC
	`, claimID, actorID)
	if err != nil {
		return application.ClaimProgress{}, fmt.Errorf("load owned receipt progress: %w", err)
	}
	defer rows.Close()
	progress.Receipts = []application.ReceiptProgress{}
	for rows.Next() {
		var receipt application.ReceiptProgress
		var caseStatus string
		if err := rows.Scan(&receipt.ReceiptID, &receipt.Filename, &receipt.Status, &caseStatus); err != nil {
			return application.ClaimProgress{}, fmt.Errorf("scan receipt progress: %w", err)
		}
		switch caseStatus {
		case "OPEN", "CLAIMED":
			receipt.ReviewStatus = "PENDING"
		case "RESOLVED":
			receipt.ReviewStatus = "RESOLVED"
		case "CLOSED":
			if receipt.Status == "QUARANTINED" {
				receipt.ReviewStatus = "REUPLOAD_REQUIRED"
			} else {
				receipt.ReviewStatus = "CLOSED"
			}
		default:
			receipt.ReviewStatus = "NONE"
		}
		progress.Receipts = append(progress.Receipts, receipt)
	}
	if err := rows.Err(); err != nil {
		return application.ClaimProgress{}, fmt.Errorf("iterate receipt progress: %w", err)
	}
	return progress, nil
}

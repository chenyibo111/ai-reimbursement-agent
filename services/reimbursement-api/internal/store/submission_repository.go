package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresSubmissionRepository struct{ pool *pgxpool.Pool }

func NewPostgresSubmissionRepository(pool *pgxpool.Pool) *PostgresSubmissionRepository {
	return &PostgresSubmissionRepository{pool: pool}
}

func (repository *PostgresSubmissionRepository) LoadSubmissionInput(ctx context.Context, actorID string, claimID string) (application.SubmissionInput, error) {
	claim, err := loadOwnedClaim(ctx, repository.pool, actorID, claimID, false)
	if err != nil {
		return application.SubmissionInput{}, err
	}
	receipts, err := loadClaimReceipts(ctx, repository.pool, claimID)
	if err != nil {
		return application.SubmissionInput{}, err
	}
	return application.SubmissionInput{Claim: claim, Receipts: receipts}, nil
}

func (repository *PostgresSubmissionRepository) StoreConfirmation(ctx context.Context, confirmation application.SubmissionConfirmation) error {
	_, err := repository.pool.Exec(ctx, `
		INSERT INTO reimbursement.submission_confirmations (token, claim_id, actor_id, claim_version, policy_version, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, confirmation.Token, confirmation.ClaimID, confirmation.ActorID, confirmation.ClaimVersion, confirmation.PolicyVersion, confirmation.ExpiresAt)
	if err != nil {
		return fmt.Errorf("insert submission confirmation: %w", err)
	}
	return nil
}

func (repository *PostgresSubmissionRepository) FindConfirmation(ctx context.Context, token string) (application.SubmissionConfirmation, error) {
	var confirmation application.SubmissionConfirmation
	err := repository.pool.QueryRow(ctx, `
		SELECT token, claim_id, actor_id, claim_version, policy_version, expires_at
		FROM reimbursement.submission_confirmations
		WHERE token = $1 AND used_at IS NULL
	`, token).Scan(&confirmation.Token, &confirmation.ClaimID, &confirmation.ActorID, &confirmation.ClaimVersion, &confirmation.PolicyVersion, &confirmation.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.SubmissionConfirmation{}, application.ErrClaimNotFound
	}
	if err != nil {
		return application.SubmissionConfirmation{}, fmt.Errorf("query submission confirmation: %w", err)
	}
	return confirmation, nil
}

func (repository *PostgresSubmissionRepository) FindSubmissionByIdempotencyKey(ctx context.Context, actorID string, claimID string, key string) (application.SubmissionSnapshot, error) {
	return scanSubmissionSnapshot(repository.pool.QueryRow(ctx, `
		SELECT claim_id, submission_number, claim_version, policy_version, submitted_at
		FROM reimbursement.submission_snapshots
		WHERE actor_id = $1 AND claim_id = $2 AND idempotency_key = $3
	`, actorID, claimID, key))
}

func (repository *PostgresSubmissionRepository) Submit(ctx context.Context, input application.SubmissionInput, confirmation application.SubmissionConfirmation, idempotencyKey string, policyVersion string) (application.SubmissionSnapshot, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("begin submission: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if replay, replayErr := scanSubmissionSnapshot(tx.QueryRow(ctx, `
		SELECT claim_id, submission_number, claim_version, policy_version, submitted_at
		FROM reimbursement.submission_snapshots
		WHERE actor_id = $1 AND claim_id = $2 AND idempotency_key = $3
	`, input.Claim.OwnerID, input.Claim.ID, idempotencyKey)); replayErr == nil {
		return replay, nil
	} else if !errors.Is(replayErr, application.ErrClaimNotFound) {
		return application.SubmissionSnapshot{}, replayErr
	}

	claim, err := loadOwnedClaim(ctx, tx, input.Claim.OwnerID, input.Claim.ID, true)
	if err != nil {
		return application.SubmissionSnapshot{}, err
	}
	if claim.Status != domain.ClaimStatusDraft || claim.Version != confirmation.ClaimVersion {
		return application.SubmissionSnapshot{}, application.ErrStaleSubmissionConfirmation
	}
	receipts, err := loadClaimReceipts(ctx, tx, claim.ID)
	if err != nil {
		return application.SubmissionSnapshot{}, err
	}
	if blockingSubmissionInput(claim, receipts) {
		return application.SubmissionSnapshot{}, application.ErrValidationBlocked
	}

	submissionNumber := "SUB-" + strings.ReplaceAll(randomUUID(), "-", "")[:16]
	payload, err := json.Marshal(struct {
		Claim         domain.Claim     `json:"claim"`
		Receipts      []domain.Receipt `json:"receipts"`
		PolicyVersion string           `json:"policyVersion"`
	}{claim, receipts, policyVersion})
	if err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("marshal submission snapshot: %w", err)
	}
	result, err := tx.Exec(ctx, `
		UPDATE reimbursement.claims
		SET status = 'SUBMITTED', submitted_at = now(), submission_number = $4, version = version + 1, updated_at = now()
		WHERE id = $1 AND owner_id = $2 AND status = 'DRAFT' AND version = $3
	`, claim.ID, claim.OwnerID, confirmation.ClaimVersion, submissionNumber)
	if err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("mark claim submitted: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.SubmissionSnapshot{}, application.ErrStaleSubmissionConfirmation
	}
	var snapshot application.SubmissionSnapshot
	err = tx.QueryRow(ctx, `
		INSERT INTO reimbursement.submission_snapshots (claim_id, actor_id, submission_number, claim_version, policy_version, idempotency_key, snapshot)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
		RETURNING claim_id, submission_number, claim_version, policy_version, submitted_at
	`, claim.ID, claim.OwnerID, submissionNumber, claim.Version, policyVersion, idempotencyKey, payload).Scan(&snapshot.ClaimID, &snapshot.SubmissionNumber, &snapshot.ClaimVersion, &snapshot.PolicyVersion, &snapshot.SubmittedAt)
	if err != nil {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) && pgError.Code == "23505" {
			return application.SubmissionSnapshot{}, application.ErrStaleSubmissionConfirmation
		}
		return application.SubmissionSnapshot{}, fmt.Errorf("insert submission snapshot: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.submission_confirmations SET used_at = now() WHERE token = $1`, confirmation.Token); err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("consume confirmation: %w", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.claim_audits (claim_id, actor_id, action, claim_version) VALUES ($1, $2, 'CLAIM_SUBMITTED', $3)`, claim.ID, claim.OwnerID, claim.Version); err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("audit submitted claim: %w", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.outbox_events (event_id, event_type, aggregate_id, payload) VALUES ($1::uuid, 'claim.submitted.v1', $2, $3::jsonb)`, randomUUID(), claim.ID, payload); err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("write submitted event: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("commit submission: %w", err)
	}
	return snapshot, nil
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadOwnedClaim(ctx context.Context, query queryRower, actorID string, claimID string, forUpdate bool) (domain.Claim, error) {
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE"
	}
	var claim domain.Claim
	var expenseCategory *string
	var participants []byte
	var projectCode *string
	err := query.QueryRow(ctx, `SELECT id, owner_id, status, purpose, expense_category, participants, project_code, version, created_at, updated_at FROM reimbursement.claims WHERE id = $1 AND owner_id = $2`+lock, claimID, actorID).Scan(&claim.ID, &claim.OwnerID, &claim.Status, &claim.Purpose, &expenseCategory, &participants, &projectCode, &claim.Version, &claim.CreatedAt, &claim.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Claim{}, application.ErrClaimNotFound
	}
	if err != nil {
		return domain.Claim{}, fmt.Errorf("load owned claim: %w", err)
	}
	if expenseCategory != nil {
		claim.ExpenseCategory = *expenseCategory
	}
	if projectCode != nil {
		claim.ProjectCode = *projectCode
	}
	if err := json.Unmarshal(participants, &claim.Participants); err != nil {
		return domain.Claim{}, fmt.Errorf("decode claim participants: %w", err)
	}
	return claim, nil
}

func loadClaimReceipts(ctx context.Context, query interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, claimID string) ([]domain.Receipt, error) {
	rows, err := query.Query(ctx, `SELECT id, claim_id, owner_id, filename, content_type, expected_size, object_key, content_hash, status, invoice_number, ocr_confidence, created_at, updated_at FROM reimbursement.receipts WHERE claim_id = $1`, claimID)
	if err != nil {
		return nil, fmt.Errorf("load claim receipts: %w", err)
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
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claim receipts: %w", err)
	}
	return receipts, nil
}

func scanSubmissionSnapshot(row receiptRow) (application.SubmissionSnapshot, error) {
	var snapshot application.SubmissionSnapshot
	err := row.Scan(&snapshot.ClaimID, &snapshot.SubmissionNumber, &snapshot.ClaimVersion, &snapshot.PolicyVersion, &snapshot.SubmittedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.SubmissionSnapshot{}, application.ErrClaimNotFound
	}
	if err != nil {
		return application.SubmissionSnapshot{}, fmt.Errorf("scan submission snapshot: %w", err)
	}
	return snapshot, nil
}

func blockingSubmissionInput(claim domain.Claim, receipts []domain.Receipt) bool {
	if claim.Status != domain.ClaimStatusDraft || strings.TrimSpace(claim.Purpose) == "" || len(receipts) == 0 {
		return true
	}
	for _, receipt := range receipts {
		if receipt.Status != domain.ReceiptStatusExtracted || (receipt.OCRConfidence > 0 && receipt.OCRConfidence < 0.7) {
			return true
		}
	}
	return false
}

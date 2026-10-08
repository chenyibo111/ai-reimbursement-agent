package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresClaimRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresClaimRepository(pool *pgxpool.Pool) *PostgresClaimRepository {
	return &PostgresClaimRepository{pool: pool}
}

func (repository *PostgresClaimRepository) Create(ctx context.Context, claim domain.Claim, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin claim creation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	participants, err := json.Marshal(claim.Participants)
	if err != nil {
		return fmt.Errorf("encode participants: %w", err)
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO reimbursement.claims (id, claim_number, owner_id, status, purpose, expense_category, participants, project_code, requested_amount_cent, currency, requested_amount_source, remark, version, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7::jsonb, NULLIF($8, ''), $9, $10, $11, NULLIF($12, ''), $13, $14, $15)
	`, claim.ID, claim.ClaimNumber, claim.OwnerID, claim.Status, claim.Purpose, claim.ExpenseCategory, participants, claim.ProjectCode, claim.RequestedAmountCent, claim.Currency, claim.RequestedAmountSource, claim.Remark, claim.Version, claim.CreatedAt, claim.UpdatedAt); err != nil {
		return fmt.Errorf("insert claim: %w", err)
	}
	if err = writeClaimAuditAndEvent(ctx, tx, audit, event); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit claim creation: %w", err)
	}
	return nil
}

func (repository *PostgresClaimRepository) FindOwned(ctx context.Context, claimID string, actorID string) (domain.Claim, error) {
	claim, err := scanClaim(repository.pool.QueryRow(ctx, `
		SELECT claim.id, claim.claim_number, claim.owner_id, claim.status, claim.purpose, claim.expense_category, claim.participants, claim.project_code,
		       claim.requested_amount_cent, claim.currency, claim.requested_amount_source, claim.remark,
		       claim.version, claim.created_at, claim.updated_at,
		       summary.receipt_count, summary.recognized_receipt_count, summary.total_amount_cent, summary.missing_amount_receipt_count
		FROM reimbursement.claims AS claim
		LEFT JOIN LATERAL (
			SELECT
				count(*)::INTEGER AS receipt_count,
				(count(*) FILTER (WHERE receipt.status = 'EXTRACTED'))::INTEGER AS recognized_receipt_count,
				sum(receipt.total_amount_cent) FILTER (WHERE receipt.status = 'EXTRACTED' AND receipt.total_amount_cent IS NOT NULL) AS total_amount_cent,
				(count(*) FILTER (WHERE receipt.status = 'EXTRACTED' AND receipt.total_amount_cent IS NULL))::INTEGER AS missing_amount_receipt_count
			FROM reimbursement.receipts AS receipt
			WHERE receipt.claim_id = claim.id
		) AS summary ON TRUE
		WHERE claim.id = $1 AND claim.owner_id = $2
	`, claimID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Claim{}, application.ErrClaimNotFound
	}
	if err != nil {
		return domain.Claim{}, fmt.Errorf("query owned claim: %w", err)
	}
	return claim, nil
}

type claimRow interface{ Scan(...any) error }

func scanClaim(row claimRow) (domain.Claim, error) {
	var claim domain.Claim
	var participants []byte
	var expenseCategory *string
	var projectCode *string
	var remark *string
	err := row.Scan(
		&claim.ID, &claim.ClaimNumber, &claim.OwnerID, &claim.Status, &claim.Purpose, &expenseCategory, &participants,
		&projectCode, &claim.RequestedAmountCent, &claim.Currency, &claim.RequestedAmountSource, &remark, &claim.Version, &claim.CreatedAt, &claim.UpdatedAt,
		&claim.ReceiptCount, &claim.RecognizedReceiptCount, &claim.TotalAmountCent, &claim.MissingAmountReceiptCount,
	)
	if err != nil {
		return domain.Claim{}, err
	}
	if expenseCategory != nil {
		claim.ExpenseCategory = *expenseCategory
	}
	if projectCode != nil {
		claim.ProjectCode = *projectCode
	}
	if remark != nil {
		claim.Remark = *remark
	}
	if err := json.Unmarshal(participants, &claim.Participants); err != nil {
		return domain.Claim{}, fmt.Errorf("decode participants: %w", err)
	}
	return claim, nil
}

func (repository *PostgresClaimRepository) ListOwned(ctx context.Context, actorID string, limit int) ([]domain.Claim, error) {
	rows, err := repository.pool.Query(ctx, `
		SELECT claim.id, claim.claim_number, claim.owner_id, claim.status, claim.purpose, claim.expense_category, claim.participants, claim.project_code,
		       claim.requested_amount_cent, claim.currency, claim.requested_amount_source, claim.remark,
		       claim.version, claim.created_at, claim.updated_at,
		       summary.receipt_count, summary.recognized_receipt_count, summary.total_amount_cent, summary.missing_amount_receipt_count
		FROM reimbursement.claims AS claim
		LEFT JOIN LATERAL (
			SELECT
				count(*)::INTEGER AS receipt_count,
				(count(*) FILTER (WHERE receipt.status = 'EXTRACTED'))::INTEGER AS recognized_receipt_count,
				sum(receipt.total_amount_cent) FILTER (WHERE receipt.status = 'EXTRACTED' AND receipt.total_amount_cent IS NOT NULL) AS total_amount_cent,
				(count(*) FILTER (WHERE receipt.status = 'EXTRACTED' AND receipt.total_amount_cent IS NULL))::INTEGER AS missing_amount_receipt_count
			FROM reimbursement.receipts AS receipt
			WHERE receipt.claim_id = claim.id
		) AS summary ON TRUE
		WHERE claim.owner_id = $1
		ORDER BY claim.created_at DESC
		LIMIT $2
	`, actorID, limit)
	if err != nil {
		return nil, fmt.Errorf("list owned claims: %w", err)
	}
	defer rows.Close()
	claims := []domain.Claim{}
	for rows.Next() {
		claim, err := scanClaim(rows)
		if err != nil {
			return nil, err
		}
		claims = append(claims, claim)
	}
	return claims, rows.Err()
}

func (repository *PostgresClaimRepository) Update(ctx context.Context, claim domain.Claim, expectedVersion int64, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin claim update: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	participants, err := json.Marshal(claim.Participants)
	if err != nil {
		return fmt.Errorf("encode participants: %w", err)
	}
	result, err := tx.Exec(ctx, `
		UPDATE reimbursement.claims
		SET purpose = $4, expense_category = NULLIF($5, ''), participants = $6::jsonb,
		    project_code = NULLIF($7, ''), requested_amount_cent = $8, currency = $9,
		    requested_amount_source = $10, remark = NULLIF($11, ''), version = $12, updated_at = $13
		WHERE id = $1 AND owner_id = $2 AND status = 'DRAFT' AND version = $3
	`, claim.ID, claim.OwnerID, expectedVersion, claim.Purpose, claim.ExpenseCategory, participants, claim.ProjectCode, claim.RequestedAmountCent, claim.Currency, claim.RequestedAmountSource, claim.Remark, claim.Version, claim.UpdatedAt)
	if err != nil {
		return fmt.Errorf("update claim: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ErrClaimVersionConflict
	}
	if err = writeClaimAuditAndEvent(ctx, tx, audit, event); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit claim update: %w", err)
	}
	return nil
}

func (repository *PostgresClaimRepository) Delete(ctx context.Context, claimID string, actorID string, expectedVersion int64, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin claim deletion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := tx.Exec(ctx, `
		DELETE FROM reimbursement.claims
		WHERE id = $1 AND owner_id = $2 AND status = 'DRAFT' AND version = $3
	`, claimID, actorID, expectedVersion)
	if err != nil {
		return fmt.Errorf("delete claim: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ErrClaimVersionConflict
	}
	if err = writeClaimAuditAndEvent(ctx, tx, audit, event); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit claim deletion: %w", err)
	}
	return nil
}

func writeClaimAuditAndEvent(ctx context.Context, tx pgx.Tx, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO reimbursement.claim_audits (claim_id, actor_id, action, claim_version)
		VALUES ($1, $2, $3, $4)
	`, audit.ClaimID, audit.ActorID, audit.Action, audit.Version); err != nil {
		return fmt.Errorf("insert claim audit: %w", err)
	}
	payload, err := json.Marshal(map[string]any{"claimId": event.ClaimID, "version": event.Version})
	if err != nil {
		return fmt.Errorf("encode claim event: %w", err)
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO reimbursement.outbox_events (event_id, event_type, aggregate_id, payload)
		VALUES ($1::uuid, $2, $3, $4::jsonb)
	`, randomUUID(), event.Type, event.ClaimID, payload); err != nil {
		return fmt.Errorf("insert claim outbox event: %w", err)
	}
	return nil
}

func randomUUID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(bytes[0:4]), hex.EncodeToString(bytes[4:6]), hex.EncodeToString(bytes[6:8]), hex.EncodeToString(bytes[8:10]), hex.EncodeToString(bytes[10:16]))
}

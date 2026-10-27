package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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

func (repository *PostgresClaimRepository) FindOwnedByNumber(ctx context.Context, claimNumber string, actorID string) (domain.Claim, error) {
	var claimID string
	err := repository.pool.QueryRow(ctx, `SELECT id FROM reimbursement.claims WHERE claim_number = $1 AND owner_id = $2`, claimNumber, actorID).Scan(&claimID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Claim{}, application.ErrClaimNotFound
	}
	if err != nil {
		return domain.Claim{}, fmt.Errorf("query owned claim number: %w", err)
	}
	return repository.FindOwned(ctx, claimID, actorID)
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

func (repository *PostgresClaimRepository) SearchOwned(ctx context.Context, actorID string, query application.SearchClaimsQuery) ([]domain.Claim, int64, error) {
	args := []any{actorID}
	conditions := []string{"owner_id = $1"}
	add := func(column string, value any, operator string) {
		args = append(args, value)
		conditions = append(conditions, fmt.Sprintf("%s %s $%d", column, operator, len(args)))
	}
	if query.Status != "" {
		add("status", query.Status, "=")
	}
	if !query.CreatedFrom.IsZero() {
		add("created_at", query.CreatedFrom, ">=")
	}
	if !query.CreatedBefore.IsZero() {
		add("created_at", query.CreatedBefore, "<")
	}
	if query.PurposeContains != "" {
		args = append(args, "%"+escapeLike(query.PurposeContains)+"%")
		conditions = append(conditions, fmt.Sprintf("purpose ILIKE $%d ESCAPE '\\'", len(args)))
	}
	if query.ExpenseCategory != "" {
		add("expense_category", query.ExpenseCategory, "=")
	}
	if query.MinRequestedAmountCent != nil {
		add("requested_amount_cent", *query.MinRequestedAmountCent, ">=")
	}
	if query.MaxRequestedAmountCent != nil {
		add("requested_amount_cent", *query.MaxRequestedAmountCent, "<=")
	}
	baseWhere := strings.Join(conditions, " AND ")
	var total int64
	if err := repository.pool.QueryRow(ctx, "SELECT count(*) FROM reimbursement.claims WHERE "+baseWhere, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count owned claims: %w", err)
	}
	if query.CountOnly {
		return []domain.Claim{}, total, nil
	}
	order := "created_at DESC, id ASC"
	column := "created_at"
	comparison := "<"
	switch query.Sort {
	case application.ClaimSearchCreatedAsc:
		order, comparison = "created_at ASC, id ASC", ">"
	case application.ClaimSearchAmountDesc:
		order, column = "requested_amount_cent DESC NULLS LAST, id ASC", "requested_amount_cent"
	case application.ClaimSearchAmountAsc:
		order, column, comparison = "requested_amount_cent ASC NULLS LAST, id ASC", "requested_amount_cent", ">"
	}
	if query.AfterID != "" {
		if column == "created_at" {
			at, err := time.Parse(time.RFC3339Nano, query.AfterValue)
			if err != nil {
				return nil, 0, application.ErrInvalidClaimSearch
			}
			args = append(args, at, query.AfterID)
			conditions = append(conditions, fmt.Sprintf("(created_at %s $%d OR (created_at = $%d AND id > $%d))", comparison, len(args)-1, len(args)-1, len(args)))
		} else if query.AfterNull {
			args = append(args, query.AfterID)
			conditions = append(conditions, fmt.Sprintf("(requested_amount_cent IS NULL AND id > $%d)", len(args)))
		} else {
			var amount int64
			if _, err := fmt.Sscan(query.AfterValue, &amount); err != nil {
				return nil, 0, application.ErrInvalidClaimSearch
			}
			args = append(args, amount, query.AfterID)
			conditions = append(conditions, fmt.Sprintf("(requested_amount_cent IS NULL OR requested_amount_cent %s $%d OR (requested_amount_cent = $%d AND id > $%d))", comparison, len(args)-1, len(args)-1, len(args)))
		}
	}
	args = append(args, query.Limit+1)
	statement := fmt.Sprintf("SELECT id FROM reimbursement.claims WHERE %s ORDER BY %s LIMIT $%d", strings.Join(conditions, " AND "), order, len(args))
	rows, err := repository.pool.Query(ctx, statement, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("search owned claim ids: %w", err)
	}
	ids := make([]string, 0, query.Limit+1)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, 0, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	claims := make([]domain.Claim, 0, len(ids))
	for _, id := range ids {
		claim, err := repository.FindOwned(ctx, id, actorID)
		if err != nil {
			return nil, 0, err
		}
		claims = append(claims, claim)
	}
	return claims, total, nil
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
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

// RefreshOCRSuggestion derives a claim-level requested amount from the OCR
// totals currently persisted for its extracted receipts. Its source predicate
// makes a concurrent or prior manual employee edit a safe no-op.
func (repository *PostgresClaimRepository) RefreshOCRSuggestion(ctx context.Context, claimID string, actorID string) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin OCR suggestion refresh: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var version int64
	err = tx.QueryRow(ctx, `
		WITH suggestion AS (
			SELECT sum(total_amount_cent) AS requested_amount_cent
			FROM reimbursement.receipts
			WHERE claim_id = $1
			  AND status = 'EXTRACTED'
			  AND total_amount_cent IS NOT NULL
		)
		UPDATE reimbursement.claims AS claim
		SET requested_amount_cent = suggestion.requested_amount_cent,
		    version = claim.version + 1,
		    updated_at = now()
		FROM suggestion
		WHERE claim.id = $1
		  AND claim.owner_id = $2
		  AND claim.status = 'DRAFT'
		  AND claim.requested_amount_source = 'OCR_SUGGESTED'
		  AND claim.requested_amount_cent IS DISTINCT FROM suggestion.requested_amount_cent
		RETURNING claim.version
	`, claimID, actorID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return fmt.Errorf("refresh OCR suggestion: %w", err)
	}
	if err = writeClaimAuditAndEvent(ctx, tx,
		application.ClaimAudit{ClaimID: claimID, ActorID: actorID, Action: "CLAIM_OCR_SUGGESTION_REFRESHED", Version: version},
		application.ClaimOutboxEvent{ClaimID: claimID, Type: "ClaimOCRSuggestionRefreshed", Version: version},
	); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit OCR suggestion refresh: %w", err)
	}
	return nil
}

func (repository *PostgresClaimRepository) Delete(ctx context.Context, claimID string, actorID string, expectedVersion int64, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin claim deletion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = deleteClaimInTx(ctx, tx, claimID, actorID, expectedVersion, audit, event); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit claim deletion: %w", err)
	}
	return nil
}

func (repository *PostgresClaimRepository) DeleteIdempotent(ctx context.Context, claimID string, actorID string, expectedVersion int64, key string, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin idempotent claim deletion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hash := fmt.Sprintf("%s:%d", claimID, expectedVersion)
	if _, err = tx.Exec(ctx, `
		INSERT INTO reimbursement.idempotency_records (actor_id, operation, idempotency_key, request_hash)
		VALUES ($1, 'claim.delete', $2, $3) ON CONFLICT DO NOTHING
	`, actorID, key, hash); err != nil {
		return fmt.Errorf("record claim deletion key: %w", err)
	}
	var storedHash string
	var completedStatus *int
	if err = tx.QueryRow(ctx, `
		SELECT request_hash, status_code FROM reimbursement.idempotency_records
		WHERE actor_id=$1 AND operation='claim.delete' AND idempotency_key=$2 FOR UPDATE
	`, actorID, key).Scan(&storedHash, &completedStatus); err != nil {
		return fmt.Errorf("lock claim deletion key: %w", err)
	}
	if storedHash != hash {
		return application.ErrClaimVersionConflict
	}
	if completedStatus != nil && *completedStatus == 204 {
		return tx.Commit(ctx)
	}
	if err = deleteClaimInTx(ctx, tx, claimID, actorID, expectedVersion, audit, event); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.idempotency_records SET status_code=204, response_body='', completed_at=now() WHERE actor_id=$1 AND operation='claim.delete' AND idempotency_key=$2`, actorID, key); err != nil {
		return fmt.Errorf("complete claim deletion key: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit idempotent claim deletion: %w", err)
	}
	return nil
}

func deleteClaimInTx(ctx context.Context, tx pgx.Tx, claimID string, actorID string, expectedVersion int64, audit application.ClaimAudit, event application.ClaimOutboxEvent) error {
	var status domain.ClaimStatus
	var version int64
	err := tx.QueryRow(ctx, `SELECT status, version FROM reimbursement.claims WHERE id=$1 AND owner_id=$2 FOR UPDATE`, claimID, actorID).Scan(&status, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrClaimNotFound
	}
	if err != nil {
		return fmt.Errorf("lock claim for deletion: %w", err)
	}
	if status != domain.ClaimStatusDraft {
		return domain.ErrClaimNotDraft
	}
	if version != expectedVersion {
		return application.ErrClaimVersionConflict
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO reimbursement.object_cleanup_jobs (object_key)
		SELECT object_key FROM reimbursement.receipts WHERE claim_id=$1
		ON CONFLICT (object_key) DO NOTHING
	`, claimID); err != nil {
		return fmt.Errorf("queue claim objects for cleanup: %w", err)
	}
	if _, err = tx.Exec(ctx, `
		WITH closed AS (
			UPDATE reimbursement.review_cases
			SET claim_id=NULL, receipt_id=NULL,
			    status=CASE WHEN status IN ('OPEN','CLAIMED') THEN 'CLOSED' ELSE status END,
			    resolution=CASE WHEN status IN ('OPEN','CLAIMED') THEN 'CLAIM_DELETED' ELSE resolution END,
			    resolved_by=CASE WHEN status IN ('OPEN','CLAIMED') THEN $2 ELSE resolved_by END,
			    resolved_at=CASE WHEN status IN ('OPEN','CLAIMED') THEN now() ELSE resolved_at END,
			    updated_at=now(), version=version+1
			WHERE claim_id=$1 RETURNING id
		)
		INSERT INTO reimbursement.review_case_audits (review_case_id, actor_id, action)
		SELECT id, $2, 'CLAIM_DELETED_BY_EMPLOYEE' FROM closed
	`, claimID, actorID); err != nil {
		return fmt.Errorf("close claim review cases: %w", err)
	}
	result, err := tx.Exec(ctx, `DELETE FROM reimbursement.claims WHERE id=$1 AND owner_id=$2 AND status='DRAFT' AND version=$3`, claimID, actorID, expectedVersion)
	if err != nil {
		return fmt.Errorf("delete claim: %w", err)
	}
	if result.RowsAffected() != 1 {
		return application.ErrClaimVersionConflict
	}
	return writeClaimAuditAndEvent(ctx, tx, audit, event)
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

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresExpenseItemRepository struct{ pool *pgxpool.Pool }

func NewPostgresExpenseItemRepository(pool *pgxpool.Pool) *PostgresExpenseItemRepository {
	return &PostgresExpenseItemRepository{pool: pool}
}

func (repository *PostgresExpenseItemRepository) ConvertOwnedDraft(ctx context.Context, actorID, claimID string, expectedVersion int64) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status, mode string
	var version int64
	err = tx.QueryRow(ctx, `SELECT status, itemization_mode, version FROM reimbursement.claims WHERE id=$1 AND owner_id=$2 FOR UPDATE`, claimID, actorID).Scan(&status, &mode, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrClaimNotFound
	}
	if err != nil {
		return err
	}
	if status != "DRAFT" {
		return domain.ErrClaimNotDraft
	}
	if version != expectedVersion {
		return application.ErrClaimVersionConflict
	}
	if mode == "ITEMIZED" {
		return tx.Commit(ctx)
	}
	_, err = tx.Exec(ctx, `INSERT INTO reimbursement.expense_items(id, claim_id, receipt_id, amount_cent, amount_source)
		SELECT receipt.id, receipt.claim_id, receipt.id, receipt.total_amount_cent,
		       CASE WHEN receipt.total_amount_cent IS NULL THEN '' ELSE 'OCR' END
		FROM reimbursement.receipts AS receipt
		WHERE receipt.claim_id=$1 AND receipt.owner_id=$2 AND receipt.status='EXTRACTED'
		ON CONFLICT(receipt_id) DO NOTHING`, claimID, actorID)
	if err != nil {
		return fmt.Errorf("backfill expense items: %w", err)
	}
	_, err = tx.Exec(ctx, `UPDATE reimbursement.claims SET itemization_mode='ITEMIZED' WHERE id=$1`, claimID)
	if err != nil {
		return err
	}
	if err := advanceExpenseItemClaim(ctx, tx, claimID, actorID, version); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (repository *PostgresExpenseItemRepository) UpsertFromOCR(ctx context.Context, actorID, receiptID string, suggestion domain.ExpenseItemSuggestion) (domain.ExpenseItem, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.ExpenseItem{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimID, status, mode string
	var version int64
	err = tx.QueryRow(ctx, `SELECT claim.id, claim.status, claim.itemization_mode, claim.version
		FROM reimbursement.claims claim JOIN reimbursement.receipts receipt ON receipt.claim_id=claim.id
		WHERE receipt.id=$1 AND claim.owner_id=$2 AND receipt.owner_id=$2 FOR UPDATE OF claim`, receiptID, actorID).Scan(&claimID, &status, &mode, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ExpenseItem{}, application.ErrClaimNotFound
	}
	if err != nil {
		return domain.ExpenseItem{}, fmt.Errorf("lock claim for expense item: %w", err)
	}
	if status != "DRAFT" {
		return domain.ExpenseItem{}, domain.ErrClaimNotDraft
	}
	if mode != "ITEMIZED" {
		return domain.ExpenseItem{}, domain.ErrInvalidClaim
	}
	item, err := scanExpenseItem(tx.QueryRow(ctx, expenseItemSelect+` WHERE receipt_id=$1 FOR UPDATE`, receiptID))
	created := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !created {
		return domain.ExpenseItem{}, fmt.Errorf("read expense item: %w", err)
	}
	if created {
		item = domain.ExpenseItem{ID: receiptID, ClaimID: claimID, ReceiptID: receiptID}
	}
	before := item
	item.ApplySuggestion(suggestion)
	if !created && equalExpenseItem(before, item) {
		return item, tx.Commit(ctx)
	}
	if err := saveExpenseItem(ctx, tx, item); err != nil {
		return domain.ExpenseItem{}, err
	}
	if err := advanceExpenseItemClaim(ctx, tx, claimID, actorID, version); err != nil {
		return domain.ExpenseItem{}, err
	}
	return item, tx.Commit(ctx)
}

func (repository *PostgresExpenseItemRepository) ListOwnedByClaim(ctx context.Context, actorID, claimID string) ([]domain.ExpenseItem, error) {
	var exists bool
	if err := repository.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM reimbursement.claims WHERE id=$1 AND owner_id=$2)`, claimID, actorID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, application.ErrClaimNotFound
	}
	rows, err := repository.pool.Query(ctx, expenseItemSelect+` WHERE claim_id=$1 ORDER BY created_at, receipt_id`, claimID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.ExpenseItem{}
	for rows.Next() {
		item, err := scanExpenseItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (repository *PostgresExpenseItemRepository) PatchOwnedDraft(ctx context.Context, actorID, claimID, itemID string, expectedClaimVersion int64, patch domain.ExpenseItemPatch) (domain.ExpenseItem, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.ExpenseItem{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status, mode string
	var version int64
	err = tx.QueryRow(ctx, `SELECT status, itemization_mode, version FROM reimbursement.claims WHERE id=$1 AND owner_id=$2 FOR UPDATE`, claimID, actorID).Scan(&status, &mode, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ExpenseItem{}, application.ErrClaimNotFound
	}
	if err != nil {
		return domain.ExpenseItem{}, err
	}
	if status != "DRAFT" {
		return domain.ExpenseItem{}, domain.ErrClaimNotDraft
	}
	if mode != "ITEMIZED" {
		return domain.ExpenseItem{}, domain.ErrInvalidClaim
	}
	if version != expectedClaimVersion {
		return domain.ExpenseItem{}, application.ErrClaimVersionConflict
	}
	item, err := scanExpenseItem(tx.QueryRow(ctx, expenseItemSelect+` WHERE id=$1 AND claim_id=$2 FOR UPDATE`, itemID, claimID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ExpenseItem{}, application.ErrClaimNotFound
	}
	if err != nil {
		return domain.ExpenseItem{}, err
	}
	if patch.ExpenseCategory != nil {
		item.ExpenseCategory = *patch.ExpenseCategory
		item.CategorySource = domain.FieldSourceManual
	}
	if patch.Purpose != nil {
		item.Purpose = *patch.Purpose
		item.PurposeSource = domain.FieldSourceManual
	}
	if patch.AmountCent != nil {
		if *patch.AmountCent < 0 {
			return domain.ExpenseItem{}, domain.ErrInvalidClaim
		}
		amount := *patch.AmountCent
		item.AmountCent = &amount
		item.AmountSource = domain.FieldSourceManual
	}
	if patch.ProjectCode != nil {
		item.ProjectCode = *patch.ProjectCode
	}
	if patch.Participants != nil {
		item.Participants = append([]string(nil), (*patch.Participants)...)
	}
	if err := saveExpenseItem(ctx, tx, item); err != nil {
		return domain.ExpenseItem{}, err
	}
	if err := advanceExpenseItemClaim(ctx, tx, claimID, actorID, version); err != nil {
		return domain.ExpenseItem{}, err
	}
	return item, tx.Commit(ctx)
}

const expenseItemSelect = `SELECT id, claim_id, receipt_id, receipt_type, classification_status, classification_version, expense_category, category_source, purpose, purpose_source, amount_cent, amount_source, project_code, participants FROM reimbursement.expense_items`

type expenseItemRow interface{ Scan(...any) error }

func scanExpenseItem(row expenseItemRow) (domain.ExpenseItem, error) {
	var item domain.ExpenseItem
	var participants []byte
	err := row.Scan(&item.ID, &item.ClaimID, &item.ReceiptID, &item.ReceiptType, &item.ClassificationStatus, &item.ClassificationVersion, &item.ExpenseCategory, &item.CategorySource, &item.Purpose, &item.PurposeSource, &item.AmountCent, &item.AmountSource, &item.ProjectCode, &participants)
	if err != nil {
		return domain.ExpenseItem{}, err
	}
	if err := json.Unmarshal(participants, &item.Participants); err != nil {
		return domain.ExpenseItem{}, err
	}
	if item.Participants == nil {
		item.Participants = []string{}
	}
	return item, nil
}

func saveExpenseItem(ctx context.Context, tx pgx.Tx, item domain.ExpenseItem) error {
	if item.ClassificationStatus == "" {
		item.ClassificationStatus = "PENDING"
	}
	people := item.Participants
	if people == nil {
		people = []string{}
	}
	participants, err := json.Marshal(people)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO reimbursement.expense_items(id,claim_id,receipt_id,receipt_type,classification_status,classification_version,expense_category,category_source,purpose,purpose_source,amount_cent,amount_source,project_code,participants)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
		ON CONFLICT(receipt_id) DO UPDATE SET receipt_type=EXCLUDED.receipt_type, classification_status=EXCLUDED.classification_status, classification_version=EXCLUDED.classification_version, expense_category=EXCLUDED.expense_category, category_source=EXCLUDED.category_source,
		purpose=EXCLUDED.purpose, purpose_source=EXCLUDED.purpose_source, amount_cent=EXCLUDED.amount_cent, amount_source=EXCLUDED.amount_source,
		project_code=EXCLUDED.project_code, participants=EXCLUDED.participants, updated_at=now()`,
		item.ID, item.ClaimID, item.ReceiptID, item.ReceiptType, item.ClassificationStatus, item.ClassificationVersion, item.ExpenseCategory, item.CategorySource, item.Purpose, item.PurposeSource, item.AmountCent, item.AmountSource, item.ProjectCode, participants)
	return err
}

func advanceExpenseItemClaim(ctx context.Context, tx pgx.Tx, claimID, actorID string, version int64) error {
	_, err := tx.Exec(ctx, `UPDATE reimbursement.claims AS claim
		SET version=claim.version+1, updated_at=now(),
		purpose=CASE WHEN claim.purpose_source='AUTO' THEN COALESCE((
			SELECT string_agg(DISTINCT item.purpose, '、' ORDER BY item.purpose) FROM reimbursement.expense_items AS item
			JOIN reimbursement.receipts AS receipt ON receipt.id=item.receipt_id
			WHERE item.claim_id=claim.id AND receipt.status='EXTRACTED' AND item.purpose <> ''
		), '') ELSE claim.purpose END,
		requested_amount_cent=CASE WHEN claim.requested_amount_source='OCR_SUGGESTED' THEN (
			SELECT sum(item.amount_cent) FROM reimbursement.expense_items AS item
			JOIN reimbursement.receipts AS receipt ON receipt.id=item.receipt_id
			WHERE item.claim_id=claim.id AND receipt.status='EXTRACTED'
		) ELSE claim.requested_amount_cent END,
		selected_expense_categories=CASE WHEN claim.expense_categories_source='AUTO' THEN COALESCE((
			SELECT array_agg(category ORDER BY category) FROM (
				SELECT DISTINCT item.expense_category AS category FROM reimbursement.expense_items AS item
				JOIN reimbursement.receipts AS receipt ON receipt.id=item.receipt_id
				WHERE item.claim_id=claim.id AND receipt.status='EXTRACTED' AND item.expense_category <> ''
			) AS recognized
		), ARRAY[]::TEXT[]) ELSE claim.selected_expense_categories END
		WHERE claim.id=$1`, claimID)
	if err != nil {
		return err
	}
	return writeClaimAuditAndEvent(ctx, tx, application.ClaimAudit{ClaimID: claimID, ActorID: actorID, Action: "CLAIM_EXPENSE_ITEM_UPDATED", Version: version + 1}, application.ClaimOutboxEvent{ClaimID: claimID, Type: "ClaimExpenseItemUpdated", Version: version + 1})
}

func equalExpenseItem(a, b domain.ExpenseItem) bool { return reflect.DeepEqual(a, b) }

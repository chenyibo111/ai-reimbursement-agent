package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestExpenseItemUpsertPreservesManualCategoryAndOneRowPerReceipt(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	testURL, adminURL, databaseName := isolatedDatabaseURLs(t, databaseURL)
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer admin.Close(ctx)
		_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)")
	})
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	applyMigrationsThrough(t, ctx, conn, filepath.Join("..", "..", "db", "migrations"), "000026")
	_ = conn.Close(ctx)
	pool, err := pgxpool.New(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees(id, display_name) VALUES ('employee-1','One'),('employee-2','Two')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims(id, owner_id, purpose, itemization_mode, purpose_source) VALUES ('claim-1','employee-1','','ITEMIZED','AUTO')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO reimbursement.receipts(id, claim_id, owner_id, filename, content_type, expected_size, object_key, status) VALUES ('receipt-1','claim-1','employee-1','taxi.pdf','application/pdf',100,'test/receipt-1','EXTRACTED')`)
	if err != nil {
		t.Fatal(err)
	}
	repository := NewPostgresExpenseItemRepository(pool)
	amount := int64(3800)
	first, err := repository.UpsertFromOCR(ctx, "employee-1", "receipt-1", domain.ExpenseItemSuggestion{ReceiptType: "TAXI", ExpenseCategory: "交通费", CategoryCode: "LOCAL_TRANSPORT", ExpenseCatalogVersion: 1, Purpose: "市内出行打车费", AmountCent: &amount})
	if err != nil {
		t.Fatal(err)
	}
	claimRepository := NewPostgresClaimRepository(pool)
	selectedClaim, err := claimRepository.FindOwned(ctx, "claim-1", "employee-1")
	if err != nil || len(selectedClaim.SelectedExpenseCategories) != 1 || selectedClaim.SelectedExpenseCategories[0] != "交通费" || len(selectedClaim.SelectedExpenseCategoryCodes) != 1 || selectedClaim.SelectedExpenseCategoryCodes[0] != "LOCAL_TRANSPORT" || selectedClaim.ExpenseCatalogVersion != 1 || selectedClaim.ExpenseCategoriesSource != "AUTO" {
		t.Fatalf("initial final categories=%v source=%s err=%v", selectedClaim.SelectedExpenseCategories, selectedClaim.ExpenseCategoriesSource, err)
	}
	var participantsKind string
	if err := pool.QueryRow(ctx, `SELECT jsonb_typeof(participants) FROM reimbursement.expense_items WHERE receipt_id='receipt-1'`).Scan(&participantsKind); err != nil || participantsKind != "array" {
		t.Fatalf("new item participants type=%q err=%v, want array", participantsKind, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE reimbursement.expense_items SET participants='null'::jsonb WHERE receipt_id='receipt-1'`); err != nil {
		t.Fatal(err)
	}
	existing, err := repository.ListOwnedByClaim(ctx, "employee-1", "claim-1")
	if err != nil || len(existing) != 1 || existing[0].Participants == nil {
		t.Fatalf("legacy null participants were not normalized: items=%+v err=%v", existing, err)
	}
	var autoPurpose string
	if err := pool.QueryRow(ctx, `SELECT purpose FROM reimbursement.claims WHERE id='claim-1'`).Scan(&autoPurpose); err != nil || autoPurpose != "市内出行打车费" {
		t.Fatalf("auto purpose=%q err=%v", autoPurpose, err)
	}
	selected := []string{"餐饮费", "其他"}
	if err := selectedClaim.Patch(selectedClaim.Version, domain.ClaimPatch{SelectedExpenseCategories: &selected}); err != nil {
		t.Fatal(err)
	}
	if err := claimRepository.Update(ctx, selectedClaim, selectedClaim.Version-1, application.ClaimAudit{ClaimID: selectedClaim.ID, ActorID: selectedClaim.OwnerID, Action: "CLAIM_DRAFT_UPDATED", Version: selectedClaim.Version}, application.ClaimOutboxEvent{ClaimID: selectedClaim.ID, Type: "ClaimDraftUpdated", Version: selectedClaim.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.UpsertFromOCR(ctx, "employee-1", "receipt-1", domain.ExpenseItemSuggestion{ReceiptType: "TAXI", ExpenseCategory: "交通费", Purpose: "更新的打车费", AmountCent: &amount}); err != nil {
		t.Fatal(err)
	}
	selectedClaim, err = claimRepository.FindOwned(ctx, "claim-1", "employee-1")
	if err != nil || len(selectedClaim.SelectedExpenseCategories) != 2 || selectedClaim.SelectedExpenseCategories[0] != "餐饮费" || selectedClaim.SelectedExpenseCategories[1] != "其他" || selectedClaim.ExpenseCategoriesSource != "MANUAL" {
		t.Fatalf("manual final categories=%v source=%s err=%v", selectedClaim.SelectedExpenseCategories, selectedClaim.ExpenseCategoriesSource, err)
	}
	migration, err := os.ReadFile(filepath.Join("..", "..", "db", "migrations", "000023_selected_expense_categories.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("repeat category migration: %v", err)
	}
	selectedClaim, err = claimRepository.FindOwned(ctx, "claim-1", "employee-1")
	if err != nil || len(selectedClaim.SelectedExpenseCategories) != 2 || selectedClaim.SelectedExpenseCategories[0] != "餐饮费" || selectedClaim.SelectedExpenseCategories[1] != "其他" {
		t.Fatalf("migration overwrote manual categories=%v err=%v", selectedClaim.SelectedExpenseCategories, err)
	}
	manualCategory := "市内交通费"
	var version int64
	if err = pool.QueryRow(ctx, `SELECT version FROM reimbursement.claims WHERE id='claim-1'`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	_, err = repository.PatchOwnedDraft(ctx, "employee-1", "claim-1", first.ID, version, domain.ExpenseItemPatch{ExpenseCategory: &manualCategory})
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.PatchOwnedDraft(ctx, "employee-1", "claim-1", first.ID, version, domain.ExpenseItemPatch{ExpenseCategory: &manualCategory})
	if !errors.Is(err, application.ErrClaimVersionConflict) {
		t.Fatalf("stale item update: %v", err)
	}
	var requestedAfterPatch *int64
	if err = pool.QueryRow(ctx, `SELECT requested_amount_cent FROM reimbursement.claims WHERE id='claim-1'`).Scan(&requestedAfterPatch); err != nil {
		t.Fatal(err)
	}
	if requestedAfterPatch == nil || *requestedAfterPatch != 3800 {
		t.Fatalf("amount after item patch=%v", requestedAfterPatch)
	}
	amount = 4000
	_, err = repository.UpsertFromOCR(ctx, "employee-1", "receipt-1", domain.ExpenseItemSuggestion{ReceiptType: "TAXI", ExpenseCategory: "交通费", Purpose: "打车费", AmountCent: &amount})
	if err != nil {
		t.Fatal(err)
	}
	items, err := repository.ListOwnedByClaim(ctx, "employee-1", "claim-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ExpenseCategory != manualCategory || items[0].AmountCent == nil || *items[0].AmountCent != 4000 {
		t.Fatalf("unexpected items: %+v", items)
	}
	if err = NewPostgresClaimRepository(pool).RefreshOCRSuggestion(ctx, "claim-1", "employee-1"); err != nil {
		t.Fatal(err)
	}
	var requested *int64
	if err = pool.QueryRow(ctx, `SELECT requested_amount_cent FROM reimbursement.claims WHERE id='claim-1'`).Scan(&requested); err != nil {
		t.Fatal(err)
	}
	if requested == nil || *requested != 4000 {
		t.Fatalf("itemized requested amount=%v, want 4000", requested)
	}
	submissionInput, err := NewPostgresSubmissionRepository(pool).LoadSubmissionInput(ctx, "employee-1", "claim-1")
	if err != nil || submissionInput.Claim.ItemizationMode != domain.ClaimItemizationModeItemized || len(submissionInput.Items) != 1 || submissionInput.Items[0].ReceiptID != "receipt-1" {
		t.Fatalf("submission input=%+v err=%v", submissionInput, err)
	}
	other, err := repository.ListOwnedByClaim(ctx, "employee-2", "claim-1")
	if err == nil || other != nil {
		t.Fatalf("cross-owner read: items=%+v err=%v", other, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims(id, owner_id, purpose) VALUES ('legacy-claim','employee-1','旧草稿')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO reimbursement.receipts(id, claim_id, owner_id, filename, content_type, expected_size, object_key, status, total_amount_cent) VALUES ('legacy-receipt','legacy-claim','employee-1','old.pdf','application/pdf',100,'test/legacy-receipt','EXTRACTED',1200)`)
	if err != nil {
		t.Fatal(err)
	}
	var legacyVersion int64
	if err = pool.QueryRow(ctx, `SELECT version FROM reimbursement.claims WHERE id='legacy-claim'`).Scan(&legacyVersion); err != nil {
		t.Fatal(err)
	}
	if err = repository.ConvertOwnedDraft(ctx, "employee-1", "legacy-claim", legacyVersion+1); !errors.Is(err, application.ErrClaimVersionConflict) {
		t.Fatalf("stale legacy conversion: %v", err)
	}
	if err = repository.ConvertOwnedDraft(ctx, "employee-1", "legacy-claim", legacyVersion); err != nil {
		t.Fatal(err)
	}
	legacyItems, err := repository.ListOwnedByClaim(ctx, "employee-1", "legacy-claim")
	if err != nil {
		t.Fatal(err)
	}
	if len(legacyItems) != 1 || legacyItems[0].AmountCent == nil || *legacyItems[0].AmountCent != 1200 || legacyItems[0].ExpenseCategory != "" || legacyItems[0].Purpose != "" {
		t.Fatalf("legacy conversion invented fields: %+v", legacyItems)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims(id,owner_id,purpose,itemization_mode,purpose_source) VALUES ('mixed','employee-1','','ITEMIZED','AUTO')`); err != nil {
		t.Fatal(err)
	}
	for _, receiptID := range []string{"mixed-taxi", "mixed-dining"} {
		if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.receipts(id,claim_id,owner_id,filename,content_type,expected_size,object_key,status) VALUES ($1,'mixed','employee-1',$1,'application/pdf',100,$1,'EXTRACTED')`, receiptID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = repository.UpsertFromOCR(ctx, "employee-1", "mixed-taxi", domain.ExpenseItemSuggestion{ReceiptType: "TAXI", ExpenseCategory: "交通费", Purpose: "市内出行打车费", AmountCent: &amount}); err != nil {
		t.Fatal(err)
	}
	if _, err = repository.UpsertFromOCR(ctx, "employee-1", "mixed-dining", domain.ExpenseItemSuggestion{ReceiptType: "DINING", ExpenseCategory: "餐饮费", Purpose: "餐饮费用", AmountCent: &amount}); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT purpose FROM reimbursement.claims WHERE id='mixed'`).Scan(&autoPurpose); err != nil || autoPurpose != "市内出行打车费、餐饮费用" {
		t.Fatalf("mixed purpose=%q err=%v", autoPurpose, err)
	}
	mixedClaim, err := claimRepository.FindOwned(ctx, "mixed", "employee-1")
	if err != nil || len(mixedClaim.SelectedExpenseCategories) != 2 || mixedClaim.SelectedExpenseCategories[0] != "交通费" || mixedClaim.SelectedExpenseCategories[1] != "餐饮费" {
		t.Fatalf("mixed final categories=%v err=%v", mixedClaim.SelectedExpenseCategories, err)
	}
	if _, err = pool.Exec(ctx, `UPDATE reimbursement.claims SET purpose='客户拜访',purpose_source='MANUAL' WHERE id='mixed'`); err != nil {
		t.Fatal(err)
	}
	if _, err = repository.UpsertFromOCR(ctx, "employee-1", "mixed-dining", domain.ExpenseItemSuggestion{Purpose: "工作餐费", AmountCent: &amount}); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT purpose FROM reimbursement.claims WHERE id='mixed'`).Scan(&autoPurpose); err != nil || autoPurpose != "客户拜访" {
		t.Fatalf("manual purpose overwritten=%q err=%v", autoPurpose, err)
	}
}

func TestExpenseCategoryCodeMigrationBackfillsOnlyUniqueNames(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	testURL, adminURL, databaseName := isolatedDatabaseURLs(t, databaseURL)
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer admin.Close(ctx)
		_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)")
	})
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	dir := filepath.Join("..", "..", "db", "migrations")
	applyMigrationsThrough(t, ctx, conn, dir, "000025")
	if _, err = conn.Exec(ctx, `INSERT INTO reimbursement.employees(id,display_name) VALUES ('migration-employee','Migration')`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `INSERT INTO reimbursement.claims(id,owner_id,purpose,itemization_mode,selected_expense_categories,expense_categories_source) VALUES ('migration-claim','migration-employee','History','ITEMIZED',ARRAY['餐饮费','交通费','不存在'],'MANUAL')`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(filepath.Join(dir, "000026_expense_category_codes.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	var names, codes []string
	var review bool
	if err := conn.QueryRow(ctx, `SELECT selected_expense_categories,selected_expense_category_codes,category_review_required FROM reimbursement.claims WHERE id='migration-claim'`).Scan(&names, &codes, &review); err != nil {
		t.Fatal(err)
	}
	if len(names) != 3 || names[0] != "餐饮费" || len(codes) != 3 || codes[0] != "DINING" || codes[1] != "" || codes[2] != "" || !review {
		t.Fatalf("migration names=%v codes=%v review=%v", names, codes, review)
	}
}

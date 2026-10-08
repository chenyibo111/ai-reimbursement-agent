package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresClaimRepositorySummarizesReceipts(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)

	suffix := time.Now().UTC().Format("20060102150405.000000000")
	ownerID := "test-summary-owner-" + suffix
	claimID := "test-summary-claim-" + suffix
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Claim Summary Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Receipt summary')`, claimID, ownerID); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	for _, receipt := range []struct {
		id     string
		status string
		amount *int64
	}{
		{id: "test-summary-extracted-amount-" + suffix, status: "EXTRACTED", amount: int64Pointer(10155)},
		{id: "test-summary-extracted-missing-" + suffix, status: "EXTRACTED", amount: nil},
		{id: "test-summary-processing-" + suffix, status: "READY_FOR_OCR", amount: int64Pointer(999)},
	} {
		if _, err = pool.Exec(ctx, `
			INSERT INTO reimbursement.receipts (id, claim_id, owner_id, filename, content_type, expected_size, object_key, status, total_amount_cent)
			VALUES ($1, $2, $3, 'receipt.png', 'image/png', 1, $4, $5, $6)
		`, receipt.id, claimID, ownerID, "test/"+receipt.id, receipt.status, receipt.amount); err != nil {
			t.Fatalf("seed receipt %s: %v", receipt.id, err)
		}
	}

	repository := NewPostgresClaimRepository(pool)
	claim, err := repository.FindOwned(ctx, claimID, ownerID)
	if err != nil {
		t.Fatalf("find owned claim: %v", err)
	}
	assertClaimReceiptSummary(t, claim.ReceiptCount, claim.RecognizedReceiptCount, claim.TotalAmountCent, claim.MissingAmountReceiptCount)

	claims, err := repository.ListOwned(ctx, ownerID, 10)
	if err != nil {
		t.Fatalf("list owned claims: %v", err)
	}
	for _, listed := range claims {
		if listed.ID == claimID {
			assertClaimReceiptSummary(t, listed.ReceiptCount, listed.RecognizedReceiptCount, listed.TotalAmountCent, listed.MissingAmountReceiptCount)
			return
		}
	}
	t.Fatalf("claim %s was not returned by ListOwned", claimID)
}

func assertClaimReceiptSummary(t *testing.T, receiptCount int, recognizedCount int, totalAmount *int64, missingAmountCount int) {
	t.Helper()
	if receiptCount != 3 || recognizedCount != 2 || totalAmount == nil || *totalAmount != 10155 || missingAmountCount != 1 {
		t.Fatalf("summary = receipts:%d recognized:%d total:%#v missing:%d", receiptCount, recognizedCount, totalAmount, missingAmountCount)
	}
}

func int64Pointer(value int64) *int64 { return &value }

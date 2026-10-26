package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresReceiptDeletionQueuesObjectAndRejectsStaleVersion(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	ownerID, claimID, receiptID := "cleanup-owner-"+suffix, "cleanup-claim-"+suffix, "cleanup-receipt-"+suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Cleanup Test')`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Cleanup test')`, claimID, ownerID); err != nil {
		t.Fatal(err)
	}
	repository := NewPostgresReceiptRepository(pool)
	now := time.Now().UTC()
	key := "test/" + receiptID
	if err := repository.Create(ctx, domain.Receipt{ID: receiptID, ClaimID: claimID, OwnerID: ownerID, Filename: "same.png", ContentType: "image/png", ExpectedSize: 12, ObjectKey: key, Status: domain.ReceiptStatusUploadPending, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.review_cases (id, claim_id, receipt_id, kind, status) VALUES ($1, $2, $3, 'RECEIPT_OCR', 'OPEN')`, "cleanup-review-"+suffix, claimID, receiptID); err != nil {
		t.Fatal(err)
	}
	if err := repository.DeleteOwned(ctx, receiptID, claimID, ownerID, 2); !errors.Is(err, domain.ErrClaimVersionConflict) {
		t.Fatalf("stale deletion = %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.object_cleanup_jobs WHERE object_key = $1`, key).Scan(&count); err != nil || count != 0 {
		t.Fatalf("stale cleanup count = %d, %v", count, err)
	}
	if err := repository.DeleteOwned(ctx, receiptID, claimID, ownerID, 1); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.object_cleanup_jobs WHERE object_key = $1`, key).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cleanup count = %d, %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.receipts WHERE id = $1`, receiptID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("receipt count = %d, %v", count, err)
	}
	var version int64
	if err := pool.QueryRow(ctx, `SELECT version FROM reimbursement.claims WHERE id = $1`, claimID).Scan(&version); err != nil || version != 2 {
		t.Fatalf("version = %d, %v", version, err)
	}
	var status string
	var reviewReceiptID *string
	if err := pool.QueryRow(ctx, `SELECT status, receipt_id FROM reimbursement.review_cases WHERE id = $1`, "cleanup-review-"+suffix).Scan(&status, &reviewReceiptID); err != nil || status != "CLOSED" || reviewReceiptID != nil {
		t.Fatalf("review = %s, %#v, %v", status, reviewReceiptID, err)
	}
}

func TestPostgresReceiptRepositoryWritesAuditAndOutbox(t *testing.T) {
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
	ownerID := "test-receipt-owner-" + suffix
	claimID := "test-receipt-claim-" + suffix
	receiptID := "test-receipt-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Receipt Repository Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Receipt persistence test')`, claimID, ownerID); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	repository := NewPostgresReceiptRepository(pool)
	now := time.Now().UTC()
	receipt := domain.Receipt{ID: receiptID, ClaimID: claimID, OwnerID: ownerID, Filename: "invoice.png", ContentType: "image/png", ExpectedSize: 12, ObjectKey: "test/" + receiptID, Status: domain.ReceiptStatusUploadPending, CreatedAt: now, UpdatedAt: now}
	if err := repository.Create(ctx, receipt); err != nil {
		t.Fatalf("create receipt: %v", err)
	}
	if err := repository.MarkReadyForOCR(ctx, receiptID, "hash-"+suffix); err != nil {
		t.Fatalf("mark ready for ocr: %v", err)
	}
	invoiceDate := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	totalAmount := int64(10155)
	sellerName := "上海象鲜网络科技有限公司"
	if err := repository.MarkExtracted(ctx, receiptID, application.OCRResult{InvoiceNumber: "INV-" + suffix, InvoiceDate: &invoiceDate, TotalAmountCent: &totalAmount, SellerName: &sellerName, Confidence: 0.99}); err != nil {
		t.Fatalf("mark extracted: %v", err)
	}
	var storedInvoiceDate *time.Time
	var storedAmount *int64
	var storedSeller *string
	if err := pool.QueryRow(ctx, `SELECT invoice_date, total_amount_cent, seller_name FROM reimbursement.receipts WHERE id = $1`, receiptID).Scan(&storedInvoiceDate, &storedAmount, &storedSeller); err != nil {
		t.Fatalf("read persisted receipt metadata: %v", err)
	}
	if storedInvoiceDate == nil || storedInvoiceDate.Format("2006-01-02") != "2026-05-01" || storedAmount == nil || *storedAmount != 10155 || storedSeller == nil || *storedSeller != sellerName {
		t.Fatalf("persisted metadata = date:%#v amount:%#v seller:%#v", storedInvoiceDate, storedAmount, storedSeller)
	}
	if _, err := pool.Exec(ctx, `UPDATE reimbursement.claims SET status = 'SUBMITTED' WHERE id = $1`, claimID); err != nil {
		t.Fatalf("submit test claim: %v", err)
	}
	duplicate, err := repository.HasSubmittedInvoice(ctx, "INV-"+suffix)
	if err != nil {
		t.Fatalf("check submitted invoice: %v", err)
	}
	if !duplicate {
		t.Fatal("expected submitted invoice to be detected")
	}

	var audits, events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.receipt_audits WHERE receipt_id = $1`, receiptID).Scan(&audits); err != nil {
		t.Fatalf("count receipt audits: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.outbox_events WHERE aggregate_id = $1`, receiptID).Scan(&events); err != nil {
		t.Fatalf("count receipt outbox events: %v", err)
	}
	if audits != 3 || events != 3 {
		t.Fatalf("expected three audits and events, got audits=%d events=%d", audits, events)
	}
}

func TestPostgresReceiptRepositoryTransitionToReviewIsIdempotent(t *testing.T) {
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
	ownerID := "review-transition-owner-" + suffix
	claimID := "review-transition-claim-" + suffix
	receiptID := "review-transition-receipt-" + suffix
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.review_case_audits WHERE review_case_id IN (SELECT id FROM reimbursement.review_cases WHERE receipt_id = $1)`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.review_cases WHERE receipt_id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.receipt_review_issues WHERE receipt_id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.receipt_audits WHERE receipt_id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.outbox_events WHERE aggregate_id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.receipts WHERE id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.claims WHERE id = $1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE id = $1`, ownerID)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Review transition test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Receipt review transition test')`, claimID, ownerID); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	repository := NewPostgresReceiptRepository(pool)
	now := time.Now().UTC()
	if err := repository.Create(ctx, domain.Receipt{ID: receiptID, ClaimID: claimID, OwnerID: ownerID, Filename: "invoice.png", ContentType: "image/png", ExpectedSize: 1, ObjectKey: "test/" + receiptID, Status: domain.ReceiptStatusReadyForOCR, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("create receipt: %v", err)
	}
	amount := int64(10155)
	result := application.OCRResult{InvoiceNumber: "INV-" + suffix, TotalAmountCent: &amount, Confidence: 0.69}
	if err := repository.TransitionToReview(ctx, receiptID, "OCR_LOW_CONFIDENCE", &result); err != nil {
		t.Fatalf("first review transition: %v", err)
	}
	if err := repository.TransitionToReview(ctx, receiptID, "OCR_LOW_CONFIDENCE", &result); err != nil {
		t.Fatalf("duplicate review transition: %v", err)
	}

	var cases, issues int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.review_cases WHERE receipt_id = $1 AND status IN ('OPEN', 'CLAIMED')`, receiptID).Scan(&cases); err != nil {
		t.Fatalf("count active review cases: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.receipt_review_issues WHERE receipt_id = $1 AND code = 'OCR_LOW_CONFIDENCE'`, receiptID).Scan(&issues); err != nil {
		t.Fatalf("count review issues: %v", err)
	}
	if cases != 1 || issues != 1 {
		t.Fatalf("active cases = %d, issues = %d; want one each", cases, issues)
	}
}

package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

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
	if err := repository.MarkExtracted(ctx, receiptID, application.OCRResult{InvoiceNumber: "INV-" + suffix, Confidence: 0.99}); err != nil {
		t.Fatalf("mark extracted: %v", err)
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

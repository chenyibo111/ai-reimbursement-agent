package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresSubmissionRepositoryCreatesImmutableSnapshotAndReplays(t *testing.T) {
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
	ownerID := "test-submit-owner-" + suffix
	claimID := "test-submit-claim-" + suffix
	receiptID := "test-submit-receipt-" + suffix
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Submission Repository Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Submit claim')`, claimID, ownerID); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO reimbursement.receipts (id, claim_id, owner_id, filename, content_type, expected_size, object_key, content_hash, status, ocr_confidence)
		VALUES ($1, $2, $3, 'invoice.png', 'image/png', 12, $4, $5, 'EXTRACTED', 0.98)
	`, receiptID, claimID, ownerID, "test/"+receiptID, "hash-"+suffix); err != nil {
		t.Fatalf("seed receipt: %v", err)
	}

	clock := fixedSubmissionClock{now: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)}
	service := application.NewSubmissionService(NewPostgresSubmissionRepository(pool), clock)
	confirmation, err := service.RequestSubmission(ctx, ownerID, claimID, 1)
	if err != nil {
		t.Fatalf("request submission: %v", err)
	}
	first, err := service.SubmitClaim(ctx, ownerID, claimID, confirmation.Token, "submit-key-"+suffix)
	if err != nil {
		t.Fatalf("submit claim: %v", err)
	}
	second, err := service.SubmitClaim(ctx, ownerID, claimID, confirmation.Token, "submit-key-"+suffix)
	if err != nil {
		t.Fatalf("replay submission: %v", err)
	}
	if first.SubmissionNumber == "" || first.SubmissionNumber != second.SubmissionNumber {
		t.Fatalf("unexpected submission replay: %#v %#v", first, second)
	}

	var status string
	var snapshots, events int
	if err = pool.QueryRow(ctx, `SELECT status FROM reimbursement.claims WHERE id = $1`, claimID).Scan(&status); err != nil {
		t.Fatalf("read claim status: %v", err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.submission_snapshots WHERE claim_id = $1`, claimID).Scan(&snapshots); err != nil {
		t.Fatalf("count snapshots: %v", err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.outbox_events WHERE aggregate_id = $1 AND event_type = 'claim.submitted.v1'`, claimID).Scan(&events); err != nil {
		t.Fatalf("count submission events: %v", err)
	}
	if status != "SUBMITTED" || snapshots != 1 || events != 1 {
		t.Fatalf("expected submitted snapshot/event once, status=%s snapshots=%d events=%d", status, snapshots, events)
	}
}

type fixedSubmissionClock struct{ now time.Time }

func (clock fixedSubmissionClock) Now() time.Time { return clock.now }

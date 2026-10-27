package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresReviewCaseRepositoryClaimAndResolveAreVersioned(t *testing.T) {
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
	ownerID := "review-owner-" + suffix
	reviewerOneID := "reviewer-one-" + suffix
	reviewerTwoID := "reviewer-two-" + suffix
	claimID := "review-claim-" + suffix
	receiptID := "review-receipt-" + suffix
	caseID := "review-case-" + suffix
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.outbox_events WHERE event_type = 'ReceiptReviewResolved' AND aggregate_id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.review_case_audits WHERE review_case_id = $1`, caseID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.review_cases WHERE id = $1`, caseID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.receipts WHERE id = $1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.claims WHERE id = $1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE id IN ($1, $2, $3)`, ownerID, reviewerOneID, reviewerTwoID)
	})

	if _, err := pool.Exec(ctx, `
		INSERT INTO reimbursement.employees (id, display_name, role) VALUES
			($1, 'Review owner', 'EMPLOYEE'),
			($2, 'Reviewer one', 'FINANCE_REVIEWER'),
			($3, 'Reviewer two', 'FINANCE_REVIEWER')
	`, ownerID, reviewerOneID, reviewerTwoID); err != nil {
		t.Fatalf("seed employees: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Review repository test')`, claimID, ownerID); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO reimbursement.receipts
			(id, claim_id, owner_id, filename, content_type, expected_size, object_key, status)
		VALUES ($1, $2, $3, 'review.png', 'image/png', 1, $4, 'REVIEW_REQUIRED')
	`, receiptID, claimID, ownerID, "review-test/"+receiptID); err != nil {
		t.Fatalf("seed receipt: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO reimbursement.review_cases (id, claim_id, receipt_id, kind, reason_code, status, version)
		VALUES ($1, $2, $3, 'RECEIPT_OCR', 'OCR_LOW_CONFIDENCE', 'OPEN', 1)
	`, caseID, claimID, receiptID); err != nil {
		t.Fatalf("seed review case: %v", err)
	}

	repository := NewPostgresReviewCaseRepository(pool)
	claimed, err := repository.ClaimReceiptCase(ctx, reviewerOneID, caseID, 1)
	if err != nil {
		t.Fatalf("claim case: %v", err)
	}
	if claimed.Status != application.ReviewCaseClaimed || claimed.AssignedTo != reviewerOneID || claimed.Version != 2 || claimed.ClaimedAt == nil {
		t.Fatalf("claimed case = %#v", claimed)
	}
	if _, err := repository.ClaimReceiptCase(ctx, reviewerTwoID, caseID, 1); !errors.Is(err, application.ErrReviewCaseConflict) {
		t.Fatalf("second claim error = %v, want version/state conflict", err)
	}

	resolved, err := repository.ResolveReceiptCase(ctx, reviewerOneID, application.ResolveReceiptCaseCommand{CaseID: caseID, ExpectedVersion: 2, Action: application.ReviewCaseActionConfirm, Resolution: "确认票据字段"}, false)
	if err != nil {
		t.Fatalf("resolve case: %v", err)
	}
	if resolved.Status != application.ReviewCaseResolved || resolved.ResolvedBy != reviewerOneID || resolved.Version != 3 {
		t.Fatalf("resolved case = %#v", resolved)
	}
	var reviewEventCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.outbox_events WHERE event_type = 'ReceiptReviewResolved' AND aggregate_id = $1 AND payload->>'claimId' = $2`, receiptID, claimID).Scan(&reviewEventCount); err != nil {
		t.Fatalf("count review resolution events: %v", err)
	}
	if reviewEventCount != 1 {
		t.Fatalf("review resolution events = %d, want 1", reviewEventCount)
	}
	var claimVersion int64
	if err := pool.QueryRow(ctx, `SELECT version FROM reimbursement.claims WHERE id = $1`, claimID).Scan(&claimVersion); err != nil || claimVersion != 2 {
		t.Fatalf("claim version after review resolution = %d, %v", claimVersion, err)
	}

	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.review_case_audits WHERE review_case_id = $1`, caseID).Scan(&audits); err != nil {
		t.Fatalf("count review audits: %v", err)
	}
	if audits != 2 {
		t.Fatalf("audit rows = %d, want 2", audits)
	}
}

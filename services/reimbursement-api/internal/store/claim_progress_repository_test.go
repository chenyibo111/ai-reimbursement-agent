package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresClaimProgressScopesEmployeeAndOmitsFinanceResolution(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	ownerID, claimID, receiptID, reviewID := "progress-owner-"+suffix, "progress-claim-"+suffix, "progress-receipt-"+suffix, "progress-review-"+suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees(id,display_name) VALUES($1,'Progress Test')`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims(id,owner_id,purpose) VALUES($1,$2,'Travel')`, claimID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.receipts(id,claim_id,owner_id,filename,content_type,expected_size,object_key,status) VALUES($1,$2,$3,'ticket.pdf','application/pdf',100,$4,'REVIEW_REQUIRED')`, receiptID, claimID, ownerID, "progress/"+receiptID); err != nil {
		t.Fatal(err)
	}
	secret := "finance private resolution note"
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.review_cases(id,claim_id,receipt_id,kind,status,resolution) VALUES($1,$2,$3,'RECEIPT_OCR','OPEN',$4)`, reviewID, claimID, receiptID, secret); err != nil {
		t.Fatal(err)
	}
	repository := NewPostgresClaimProgressRepository(pool)
	progress, err := repository.LoadOwnedProgress(ctx, ownerID, claimID)
	if err != nil || len(progress.Receipts) != 1 || progress.Receipts[0].ReviewStatus != "PENDING" {
		t.Fatalf("progress=%#v err=%v", progress, err)
	}
	if strings.Contains(progress.Receipts[0].Filename, secret) {
		t.Fatal("finance note leaked")
	}
	if _, err := repository.LoadOwnedProgress(ctx, "another-employee", claimID); !errors.Is(err, application.ErrClaimNotFound) {
		t.Fatalf("foreign progress=%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE reimbursement.review_cases SET status='RESOLVED',resolution=$2 WHERE id=$1`, reviewID, secret); err != nil {
		t.Fatal(err)
	}
	resolved, err := repository.LoadOwnedProgress(ctx, ownerID, claimID)
	if err != nil || resolved.Receipts[0].ReviewStatus != "RESOLVED" {
		t.Fatalf("resolved progress=%#v err=%v", resolved, err)
	}
}

package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestReceiptReviewQueueMigrationBackfillsAndEnforcesActiveCase(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}

	ctx := context.Background()
	testDatabaseURL, adminDatabaseURL, databaseName := isolatedDatabaseURLs(t, databaseURL)
	admin, err := pgx.Connect(ctx, adminDatabaseURL)
	if err != nil {
		t.Fatalf("connect postgres database: %v", err)
	}
	t.Cleanup(func() {
		defer admin.Close(ctx)
		if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Errorf("drop isolated database: %v", err)
		}
	})
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize()); err != nil {
		t.Fatalf("create isolated database: %v", err)
	}

	conn, err := pgx.Connect(ctx, testDatabaseURL)
	if err != nil {
		t.Fatalf("connect isolated database: %v", err)
	}
	t.Cleanup(func() { conn.Close(ctx) })

	migrationsDir := filepath.Join("..", "..", "db", "migrations")
	applyMigrationsThrough(t, ctx, conn, migrationsDir, "000011")

	if _, err := conn.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ('employee-1', 'Migration Test')`); err != nil {
		t.Fatalf("seed employee: %v", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ('claim-1', 'employee-1', 'Migration backfill test')`); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO reimbursement.receipts
			(id, claim_id, owner_id, filename, content_type, expected_size, object_key, status)
		VALUES ('receipt-1', 'claim-1', 'employee-1', 'invoice.png', 'image/png', 1, 'migration-test/invoice.png', 'REVIEW_REQUIRED')
	`); err != nil {
		t.Fatalf("seed review-required receipt: %v", err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO reimbursement.receipt_review_issues (receipt_id, code)
		VALUES ('receipt-1', 'OCR_LOW_CONFIDENCE'), ('receipt-1', 'OCR_LOW_CONFIDENCE')
	`); err != nil {
		t.Fatalf("seed duplicate review issues: %v", err)
	}

	applyMigration(t, ctx, conn, filepath.Join(migrationsDir, "000012_receipt_review_queue.sql"))

	var caseID, reasonCode, status string
	if err := conn.QueryRow(ctx, `
		SELECT id, reason_code, status
		FROM reimbursement.review_cases
		WHERE receipt_id = 'receipt-1'
	`).Scan(&caseID, &reasonCode, &status); err != nil {
		t.Fatalf("read backfilled review case: %v", err)
	}
	if reasonCode != "OCR_LOW_CONFIDENCE" || status != "OPEN" {
		t.Fatalf("backfilled case = reason %q, status %q", reasonCode, status)
	}

	var issueCount int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM reimbursement.receipt_review_issues WHERE receipt_id = 'receipt-1' AND code = 'OCR_LOW_CONFIDENCE'`).Scan(&issueCount); err != nil {
		t.Fatalf("count deduplicated issues: %v", err)
	}
	if issueCount != 1 {
		t.Fatalf("deduplicated issue count = %d, want 1", issueCount)
	}

	if _, err := conn.Exec(ctx, `
		INSERT INTO reimbursement.review_cases (id, claim_id, receipt_id, kind, reason_code, status)
		VALUES ('second-active-case', 'claim-1', 'receipt-1', 'RECEIPT_OCR', 'SECOND_REASON', 'OPEN')
	`); !isUniqueViolation(err) {
		t.Fatalf("second active case error = %v, want unique violation", err)
	}
	if _, err := conn.Exec(ctx, `UPDATE reimbursement.review_cases SET status = 'RESOLVED' WHERE id = $1`, caseID); err != nil {
		t.Fatalf("resolve backfilled case: %v", err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO reimbursement.review_cases (id, claim_id, receipt_id, kind, reason_code, status)
		VALUES ('replacement-active-case', 'claim-1', 'receipt-1', 'RECEIPT_OCR', 'SECOND_REASON', 'OPEN')
	`); err != nil {
		t.Fatalf("create replacement active case: %v", err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO reimbursement.receipt_review_issues (receipt_id, code)
		VALUES ('receipt-1', 'OCR_LOW_CONFIDENCE')
	`); !isUniqueViolation(err) {
		t.Fatalf("duplicate issue error = %v, want unique violation", err)
	}
}

func isolatedDatabaseURLs(t *testing.T, databaseURL string) (testDatabaseURL, adminDatabaseURL, databaseName string) {
	t.Helper()
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse TEST_REIMBURSEMENT_DATABASE_URL: %v", err)
	}
	databaseName = fmt.Sprintf("receipt_review_queue_%d", time.Now().UTC().UnixNano())
	admin := *parsed
	admin.Path = "/postgres"
	admin.RawPath = ""
	test := *parsed
	test.Path = "/" + databaseName
	test.RawPath = ""
	return test.String(), admin.String(), databaseName
}

func applyMigrationsThrough(t *testing.T, ctx context.Context, conn *pgx.Conn, migrationsDir, lastPrefix string) {
	t.Helper()
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") && (strings.HasPrefix(entry.Name(), lastPrefix) || strings.Compare(entry.Name(), lastPrefix) < 0) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		applyMigration(t, ctx, conn, filepath.Join(migrationsDir, name))
	}
}

func applyMigration(t *testing.T, ctx context.Context, conn *pgx.Conn, path string) {
	t.Helper()
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration %s: %v", filepath.Base(path), err)
	}
	if _, err := conn.Exec(ctx, string(sql)); err != nil {
		t.Fatalf("apply migration %s: %v", filepath.Base(path), err)
	}
}

func isUniqueViolation(err error) bool {
	var databaseError *pgconn.PgError
	return err != nil && (strings.Contains(err.Error(), "duplicate key") || (errors.As(err, &databaseError) && databaseError.Code == "23505"))
}

package store

import (
	"context"
	"os"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresClaimNumberGeneratorAllocatesDistinctSameDayNumbers(t *testing.T) {
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

	generator := NewPostgresClaimNumberGenerator(pool)
	at := time.Date(2099, 1, 1, 1, 0, 0, 0, time.UTC)
	results := make(chan string, 2)
	errors := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			number, allocateErr := generator.Next(ctx, at)
			if allocateErr != nil {
				errors <- allocateErr
				return
			}
			results <- number
		}()
	}
	workers.Wait()
	close(results)
	close(errors)
	for allocateErr := range errors {
		t.Fatalf("allocate claim number: %v", allocateErr)
	}

	allocated := make([]string, 0, 2)
	for number := range results {
		allocated = append(allocated, number)
	}
	if len(allocated) != 2 || allocated[0] == allocated[1] {
		t.Fatalf("allocated numbers = %#v, want two distinct values", allocated)
	}
	pattern := regexp.MustCompile(`^BX20990101-\d{4,}$`)
	for _, number := range allocated {
		if !pattern.MatchString(number) {
			t.Fatalf("claim number = %q, want %s", number, pattern)
		}
	}
}

func TestPostgresClaimsDefaultClaimNumber(t *testing.T) {
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
	ownerID := "test-claim-number-owner-" + suffix
	claimID := "test-claim-number-" + suffix
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Claim Number Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'Claim number default')`, claimID, ownerID); err != nil {
		t.Fatalf("insert claim without number: %v", err)
	}
	var claimNumber string
	if err = pool.QueryRow(ctx, `SELECT claim_number FROM reimbursement.claims WHERE id = $1`, claimID).Scan(&claimNumber); err != nil {
		t.Fatalf("read generated number: %v", err)
	}
	if !regexp.MustCompile(`^BX\d{8}-\d{4,}$`).MatchString(claimNumber) {
		t.Fatalf("claim number = %q, want BXyyyyMMdd-sequence", claimNumber)
	}

}

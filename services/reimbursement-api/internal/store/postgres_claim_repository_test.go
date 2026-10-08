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

func TestPostgresClaimRepositoryWritesAuditAndOutboxAtomically(t *testing.T) {
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
	ownerID := "test-claim-owner-" + suffix
	claimID := "test-claim-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Claim Repository Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	service := application.NewClaimService(NewPostgresClaimRepository(pool), fixedIDGenerator{value: claimID}, NewPostgresClaimNumberGenerator(pool), time.Now)
	claim, err := service.CreateClaim(ctx, ownerID, application.CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	participants := []string{"employee-1", "employee-2"}
	updated, err := service.UpdateClaim(ctx, ownerID, claim.ID, claim.Version, application.PatchClaimCommand{Participants: &participants})
	if err != nil {
		t.Fatalf("update claim: %v", err)
	}
	if err := service.DeleteClaim(ctx, ownerID, updated.ID, updated.Version); err != nil {
		t.Fatalf("delete claim: %v", err)
	}

	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.claim_audits WHERE claim_id = $1`, claim.ID).Scan(&audits); err != nil {
		t.Fatalf("count audits: %v", err)
	}
	if audits != 3 {
		t.Fatalf("expected three audit records, got %d", audits)
	}
	var events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.outbox_events WHERE aggregate_id = $1`, claim.ID).Scan(&events); err != nil {
		t.Fatalf("count outbox events: %v", err)
	}
	if events != 3 {
		t.Fatalf("expected three outbox events, got %d", events)
	}
}

func TestPostgresClaimRepositoryReadsClaimApplicationDefaults(t *testing.T) {
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
	ownerID := "test-application-owner-" + suffix
	claimID := "test-application-claim-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Application Fields Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	service := application.NewClaimService(NewPostgresClaimRepository(pool), fixedIDGenerator{value: claimID}, NewPostgresClaimNumberGenerator(pool), time.Now)
	claim, err := service.CreateClaim(ctx, ownerID, application.CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	reloaded, err := service.GetClaim(ctx, ownerID, claim.ID)
	if err != nil {
		t.Fatalf("reload claim: %v", err)
	}
	if reloaded.Currency != domain.ClaimCurrencyCNY || reloaded.RequestedAmountSource != domain.RequestedAmountSourceSuggested || reloaded.RequestedAmountCent != nil {
		t.Fatalf("application defaults = %#v", reloaded)
	}
}

type fixedIDGenerator struct{ value string }

func (generator fixedIDGenerator) Next() string { return generator.value }

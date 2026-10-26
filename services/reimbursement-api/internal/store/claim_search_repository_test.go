package store

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresClaimSearchFiltersOwnerAndPaginatesStableTies(t *testing.T) {
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
	owner, other := "search-owner-"+suffix, "search-other-"+suffix
	for _, id := range []string{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees(id,display_name) VALUES ($1,'Search Fixture')`, id); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.claims WHERE owner_id IN ($1,$2)`, owner, other)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE id IN ($1,$2)`, owner, other)
	}()
	createdAt := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 15; i++ {
		id, claimOwner := fmt.Sprintf("search-%s-%02d", suffix, i), owner
		if i >= 12 {
			claimOwner = other
		}
		var amount any = int64(10000)
		if i == 0 {
			amount = nil
		}
		if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims(id,claim_number,owner_id,status,purpose,requested_amount_cent,created_at) VALUES ($1,$2,$3,'DRAFT','Travel fixture',$4,$5)`, id, fmt.Sprintf("BX20261026-%s%02d", strings.ReplaceAll(suffix, ".", ""), i), claimOwner, amount, createdAt); err != nil {
			t.Fatal(err)
		}
	}
	repository := NewPostgresClaimRepository(pool)
	service := application.NewClaimService(repository, nil, nil, time.Now)
	query := application.SearchClaimsQuery{PurposeContains: "Travel", Limit: 10, Sort: application.ClaimSearchCreatedDesc}
	first, err := service.SearchClaims(ctx, owner, query)
	if err != nil || first.TotalCount != 12 || len(first.Items) != 10 || first.NextCursor == "" {
		t.Fatalf("first page: %#v %v", first, err)
	}
	query.Cursor = first.NextCursor
	second, err := service.SearchClaims(ctx, owner, query)
	if err != nil || second.TotalCount != 12 || len(second.Items) != 2 || second.NextCursor != "" {
		t.Fatalf("second page: %#v %v", second, err)
	}
	seen := map[string]bool{}
	for _, claim := range append(first.Items, second.Items...) {
		if seen[claim.ID] || claim.OwnerID != owner {
			t.Fatalf("duplicate or foreign claim: %#v", claim)
		}
		seen[claim.ID] = true
	}
	minimum := int64(0)
	amountPage, err := service.SearchClaims(ctx, owner, application.SearchClaimsQuery{Limit: 20, MinRequestedAmountCent: &minimum, Sort: application.ClaimSearchAmountAsc})
	if err != nil || amountPage.TotalCount != 11 || len(amountPage.Items) != 11 {
		t.Fatalf("null amount exclusion: %#v %v", amountPage, err)
	}
}

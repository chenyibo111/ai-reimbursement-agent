package application

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestSearchClaimsPaginatesOwnedResultsWithStableTies(t *testing.T) {
	repository := NewMemoryClaimRepository()
	service := newClaimServiceForTest(repository)
	for i := 0; i < 12; i++ {
		if _, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: fmt.Sprintf("travel-%02d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		if _, err := service.CreateClaim(context.Background(), "employee-2", CreateClaimCommand{Purpose: "travel-foreign"}); err != nil {
			t.Fatal(err)
		}
	}
	query := SearchClaimsQuery{PurposeContains: "travel", Sort: ClaimSearchCreatedDesc, Limit: 10}
	first, err := service.SearchClaims(context.Background(), "employee-1", query)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 10 || first.TotalCount != 12 || first.NextCursor == "" {
		t.Fatalf("first page: %#v", first)
	}
	query.Cursor = first.NextCursor
	if _, err := service.SearchClaims(context.Background(), "employee-1", SearchClaimsQuery{Sort: ClaimSearchCreatedDesc, Limit: 10, Cursor: first.NextCursor}); !errors.Is(err, ErrInvalidClaimSearch) {
		t.Fatalf("cursor reused with different filters: %v", err)
	}
	second, err := service.SearchClaims(context.Background(), "employee-1", query)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 2 || second.TotalCount != 12 || second.NextCursor != "" {
		t.Fatalf("second page: %#v", second)
	}
	seen := map[string]bool{}
	for _, claim := range append(first.Items, second.Items...) {
		if seen[claim.ID] {
			t.Fatalf("duplicate id %s", claim.ID)
		}
		seen[claim.ID] = true
	}
}

func TestSearchClaimsRejectsInvalidFiltersAndExcludesNullAmounts(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
	_, _ = service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "travel"})
	minimum := int64(0)
	page, err := service.SearchClaims(context.Background(), "employee-1", SearchClaimsQuery{Limit: 5, MinRequestedAmountCent: &minimum})
	if err != nil || page.TotalCount != 0 {
		t.Fatalf("null amount search: %#v %v", page, err)
	}
	for _, query := range []SearchClaimsQuery{
		{Status: "UNKNOWN", Limit: 5},
		{Limit: 101},
		{Limit: 5, MinRequestedAmountCent: &minimum, MaxRequestedAmountCent: func() *int64 { n := int64(-1); return &n }()},
		{Limit: 5, Cursor: "invalid"},
		{Limit: 5, CreatedFrom: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), CreatedBefore: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)},
	} {
		if _, err := service.SearchClaims(context.Background(), "employee-1", query); !errors.Is(err, ErrInvalidClaimSearch) {
			t.Fatalf("query %#v returned %v", query, err)
		}
	}
}

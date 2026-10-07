package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresIdempotencyStoreReplaysAndRejectsConflicts(t *testing.T) {
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
	store := NewPostgresIdempotencyStore(pool)
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	request := IdempotencyRequest{ActorID: "test-idempotency-" + suffix, Operation: "claim.create", Key: "request-1", RequestHash: "hash-a"}
	calls := 0
	_, err = store.ExecuteIdempotent(ctx, request, func(context.Context, pgx.Tx) (StoredResponse, error) {
		calls++
		return StoredResponse{StatusCode: 201, Body: []byte(`{"id":"claim-1"}`)}, nil
	})
	if err != nil {
		t.Fatalf("first execution: %v", err)
	}
	second, err := store.ExecuteIdempotent(ctx, request, func(context.Context, pgx.Tx) (StoredResponse, error) {
		calls++
		return StoredResponse{StatusCode: 201, Body: []byte(`{"id":"claim-2"}`)}, nil
	})
	if err != nil {
		t.Fatalf("replay execution: %v", err)
	}
	if calls != 1 || string(second.Body) != `{"id":"claim-1"}` {
		t.Fatalf("expected stored response after one callback, calls=%d body=%s", calls, second.Body)
	}

	_, err = store.ExecuteIdempotent(ctx, IdempotencyRequest{ActorID: "employee-1", Operation: "claim.create", Key: "request-1", RequestHash: "hash-b"}, func(context.Context, pgx.Tx) (StoredResponse, error) {
		return StoredResponse{}, nil
	})
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}
}

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestExecuteIdempotentReplaysStoredResponse(t *testing.T) {
	store := NewMemoryIdempotencyStore()
	request := IdempotencyRequest{
		ActorID:     "employee-1",
		Operation:   "claim.create",
		Key:         "request-1",
		RequestHash: "hash-a",
	}

	calls := 0
	first, err := store.ExecuteIdempotent(context.Background(), request, func(context.Context, pgx.Tx) (StoredResponse, error) {
		calls++
		return StoredResponse{StatusCode: 201, Body: []byte(`{"id":"claim-1"}`)}, nil
	})
	if err != nil {
		t.Fatalf("first execution returned error: %v", err)
	}

	second, err := store.ExecuteIdempotent(context.Background(), request, func(context.Context, pgx.Tx) (StoredResponse, error) {
		calls++
		return StoredResponse{StatusCode: 201, Body: []byte(`{"id":"claim-2"}`)}, nil
	})
	if err != nil {
		t.Fatalf("second execution returned error: %v", err)
	}

	if calls != 1 {
		t.Fatalf("expected callback once, got %d", calls)
	}
	if string(first.Body) != string(second.Body) {
		t.Fatalf("expected replayed response %s, got %s", first.Body, second.Body)
	}
}

func TestExecuteIdempotentRejectsSameKeyWithDifferentRequest(t *testing.T) {
	store := NewMemoryIdempotencyStore()
	request := IdempotencyRequest{ActorID: "employee-1", Operation: "claim.create", Key: "request-1", RequestHash: "hash-a"}

	_, err := store.ExecuteIdempotent(context.Background(), request, func(context.Context, pgx.Tx) (StoredResponse, error) {
		return StoredResponse{StatusCode: 201, Body: []byte(`{"id":"claim-1"}`)}, nil
	})
	if err != nil {
		t.Fatalf("initial execution returned error: %v", err)
	}

	_, err = store.ExecuteIdempotent(context.Background(), IdempotencyRequest{
		ActorID:     "employee-1",
		Operation:   "claim.create",
		Key:         "request-1",
		RequestHash: "hash-b",
	}, func(context.Context, pgx.Tx) (StoredResponse, error) {
		return StoredResponse{}, nil
	})
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}
}

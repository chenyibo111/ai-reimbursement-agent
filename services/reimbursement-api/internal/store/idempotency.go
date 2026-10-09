package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrIdempotencyConflict   = errors.New("idempotency key was reused for a different request")
	ErrInvalidStoredResponse = errors.New("idempotent response body must be valid JSON")
)

type IdempotencyRequest struct {
	ActorID     string
	Operation   string
	Key         string
	RequestHash string
}

type StoredResponse struct {
	StatusCode int
	Body       []byte
}

type IdempotencyCallback func(context.Context, pgx.Tx) (StoredResponse, error)

type IdempotencyExecutor interface {
	ExecuteIdempotent(context.Context, IdempotencyRequest, IdempotencyCallback) (StoredResponse, error)
}

type memoryRecord struct {
	requestHash string
	response    StoredResponse
}

type MemoryIdempotencyStore struct {
	mu      sync.Mutex
	records map[string]memoryRecord
}

func NewMemoryIdempotencyStore() *MemoryIdempotencyStore {
	return &MemoryIdempotencyStore{records: make(map[string]memoryRecord)}
}

func (store *MemoryIdempotencyStore) ExecuteIdempotent(ctx context.Context, request IdempotencyRequest, callback IdempotencyCallback) (StoredResponse, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := memoryKey(request)
	if existing, found := store.records[key]; found {
		if existing.requestHash != request.RequestHash {
			return StoredResponse{}, ErrIdempotencyConflict
		}
		return cloneResponse(existing.response), nil
	}

	response, err := callback(ctx, nil)
	if err != nil {
		return StoredResponse{}, err
	}
	if !json.Valid(response.Body) {
		return StoredResponse{}, ErrInvalidStoredResponse
	}
	store.records[key] = memoryRecord{requestHash: request.RequestHash, response: cloneResponse(response)}
	return cloneResponse(response), nil
}

type PostgresIdempotencyStore struct {
	pool *pgxpool.Pool
}

func NewPostgresIdempotencyStore(pool *pgxpool.Pool) *PostgresIdempotencyStore {
	return &PostgresIdempotencyStore{pool: pool}
}

func (store *PostgresIdempotencyStore) ExecuteIdempotent(ctx context.Context, request IdempotencyRequest, callback IdempotencyCallback) (StoredResponse, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return StoredResponse{}, fmt.Errorf("begin idempotency transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var insertedHash string
	err = tx.QueryRow(ctx, `
		INSERT INTO reimbursement.idempotency_records (actor_id, operation, idempotency_key, request_hash)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT DO NOTHING
		RETURNING request_hash
	`, request.ActorID, request.Operation, request.Key, request.RequestHash).Scan(&insertedHash)
	if err == nil {
		response, callbackErr := callback(ctx, tx)
		if callbackErr != nil {
			return StoredResponse{}, callbackErr
		}
		if !json.Valid(response.Body) {
			return StoredResponse{}, ErrInvalidStoredResponse
		}
		if _, err = tx.Exec(ctx, `
			UPDATE reimbursement.idempotency_records
			SET status_code = $4, response_body = $5, completed_at = now()
			WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
		`, request.ActorID, request.Operation, request.Key, response.StatusCode, string(response.Body)); err != nil {
			return StoredResponse{}, fmt.Errorf("store idempotent response: %w", err)
		}
		if err = tx.Commit(ctx); err != nil {
			return StoredResponse{}, fmt.Errorf("commit idempotency transaction: %w", err)
		}
		return cloneResponse(response), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return StoredResponse{}, fmt.Errorf("insert idempotency record: %w", err)
	}

	var storedHash string
	var response StoredResponse
	err = tx.QueryRow(ctx, `
		SELECT request_hash, status_code, response_body
		FROM reimbursement.idempotency_records
		WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
		FOR UPDATE
	`, request.ActorID, request.Operation, request.Key).Scan(&storedHash, &response.StatusCode, &response.Body)
	if err != nil {
		return StoredResponse{}, fmt.Errorf("read idempotency record: %w", err)
	}
	if storedHash != request.RequestHash {
		return StoredResponse{}, ErrIdempotencyConflict
	}
	if err = tx.Commit(ctx); err != nil {
		return StoredResponse{}, fmt.Errorf("commit idempotency replay: %w", err)
	}
	return cloneResponse(response), nil
}

func memoryKey(request IdempotencyRequest) string {
	return request.ActorID + "\x00" + request.Operation + "\x00" + request.Key
}

func cloneResponse(response StoredResponse) StoredResponse {
	return StoredResponse{StatusCode: response.StatusCode, Body: append([]byte(nil), response.Body...)}
}

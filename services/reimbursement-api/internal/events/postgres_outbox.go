package events

import (
	"context"
	"crypto/rand"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresOutboxStore struct{ pool *pgxpool.Pool }

func NewPostgresOutboxStore(pool *pgxpool.Pool) *PostgresOutboxStore {
	return &PostgresOutboxStore{pool: pool}
}
func (store *PostgresOutboxStore) Claim(ctx context.Context, limit int) ([]OutboxEvent, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	leaseToken := leaseID()
	rows, err := tx.Query(ctx, `WITH claimed AS (SELECT event_id FROM reimbursement.outbox_events WHERE published_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < now()) ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE reimbursement.outbox_events event SET lease_token = $2::uuid, lease_expires_at = now() + interval '60 seconds' FROM claimed WHERE event.event_id = claimed.event_id RETURNING event.event_id::text, event.event_type, event.aggregate_id, event.payload::text, event.lease_token::text, event.occurred_at`, limit, leaseToken)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []OutboxEvent{}
	for rows.Next() {
		var event OutboxEvent
		var payload string
		if err := rows.Scan(&event.ID, &event.Type, &event.AggregateID, &payload, &event.LeaseToken, &event.OccurredAt); err != nil {
			return nil, err
		}
		event.Payload = []byte(payload)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return events, nil
}
func (store *PostgresOutboxStore) MarkPublished(ctx context.Context, eventID string, leaseToken string) error {
	_, err := store.pool.Exec(ctx, `UPDATE reimbursement.outbox_events SET published_at = now(), publish_attempts = publish_attempts + 1, last_failure_code = NULL, lease_token = NULL, lease_expires_at = NULL WHERE event_id = $1::uuid AND lease_token = $2::uuid AND published_at IS NULL`, eventID, leaseToken)
	return err
}
func (store *PostgresOutboxStore) MarkFailed(ctx context.Context, eventID string, leaseToken string) error {
	_, err := store.pool.Exec(ctx, `UPDATE reimbursement.outbox_events SET publish_attempts = publish_attempts + 1, last_failure_code = 'NATS_PUBLISH_FAILED', lease_token = NULL, lease_expires_at = NULL WHERE event_id = $1::uuid AND lease_token = $2::uuid AND published_at IS NULL`, eventID, leaseToken)
	return err
}
func leaseID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", 0)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

type PostgresEventDeduplicator struct {
	pool     *pgxpool.Pool
	consumer string
}

func NewPostgresEventDeduplicator(pool *pgxpool.Pool, consumer string) *PostgresEventDeduplicator {
	return &PostgresEventDeduplicator{pool: pool, consumer: consumer}
}
func (store *PostgresEventDeduplicator) Seen(ctx context.Context, eventID string) (bool, error) {
	var exists bool
	err := store.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM reimbursement.processed_events WHERE event_id = $1::uuid AND consumer_name = $2)`, eventID, store.consumer).Scan(&exists)
	return exists, err
}
func (store *PostgresEventDeduplicator) MarkSeen(ctx context.Context, eventID string) error {
	_, err := store.pool.Exec(ctx, `INSERT INTO reimbursement.processed_events (event_id, consumer_name) VALUES ($1::uuid, $2) ON CONFLICT (event_id, consumer_name) DO NOTHING`, eventID, store.consumer)
	return err
}

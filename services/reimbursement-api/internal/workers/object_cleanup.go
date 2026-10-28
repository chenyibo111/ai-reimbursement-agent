package workers

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type objectDeleter interface {
	DeleteObject(context.Context, string) error
}

// RunObjectCleanup retries durable object deletion after the corresponding
// receipt/claim transaction has committed. A lease makes crashes retryable.
func RunObjectCleanup(ctx context.Context, pool *pgxpool.Pool, objects objectDeleter) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := cleanupOneObject(ctx, pool, objects); err != nil && ctx.Err() == nil {
			log.Printf("object cleanup failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func cleanupOneObject(ctx context.Context, pool *pgxpool.Pool, objects objectDeleter) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var key string
	var attempts int
	err = tx.QueryRow(ctx, `
		SELECT object_key, attempt_count FROM reimbursement.object_cleanup_jobs
		WHERE completed_at IS NULL AND available_at <= now()
		ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
	`).Scan(&key, &attempts)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.object_cleanup_jobs SET attempt_count = attempt_count + 1, available_at = now() + interval '1 minute', updated_at = now() WHERE object_key = $1`, key); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if err = objects.DeleteObject(ctx, key); err != nil {
		// Keep the durable row and retry with bounded backoff.
		delaySeconds := 30 << min(attempts, 7)
		_, updateErr := pool.Exec(ctx, `UPDATE reimbursement.object_cleanup_jobs SET last_error = $2, available_at = now() + ($3 * interval '1 second'), updated_at = now() WHERE object_key = $1 AND completed_at IS NULL`, key, fmt.Sprintf("%v", err), delaySeconds)
		if updateErr != nil {
			return fmt.Errorf("delete object: %v; schedule retry: %w", err, updateErr)
		}
		return fmt.Errorf("delete object %s: %w", key, err)
	}
	_, err = pool.Exec(ctx, `UPDATE reimbursement.object_cleanup_jobs SET completed_at = now(), last_error = NULL, updated_at = now() WHERE object_key = $1`, key)
	return err
}

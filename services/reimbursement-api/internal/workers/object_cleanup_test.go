package workers

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type cleanupTestObjects struct {
	fail    bool
	removed []string
}

func (objects *cleanupTestObjects) DeleteObject(_ context.Context, key string) error {
	if objects.fail {
		return errors.New("storage unavailable")
	}
	objects.removed = append(objects.removed, key)
	return nil
}

func TestObjectCleanupRetriesAfterStorageFailure(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	key := "test/cleanup-retry-" + time.Now().UTC().Format("20060102150405.000000000")
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.object_cleanup_jobs (object_key, available_at) VALUES ($1, '2000-01-01')`, key); err != nil {
		t.Fatal(err)
	}
	objects := &cleanupTestObjects{fail: true}
	if err := cleanupOneObject(ctx, pool, objects); err == nil {
		t.Fatal("expected storage failure")
	}
	var completed *time.Time
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT completed_at, attempt_count FROM reimbursement.object_cleanup_jobs WHERE object_key = $1`, key).Scan(&completed, &attempts); err != nil || completed != nil || attempts != 1 {
		t.Fatalf("failed task = %v, %d, %v", completed, attempts, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE reimbursement.object_cleanup_jobs SET available_at = '2000-01-01' WHERE object_key = $1`, key); err != nil {
		t.Fatal(err)
	}
	objects.fail = false
	if err := cleanupOneObject(ctx, pool, objects); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT completed_at, attempt_count FROM reimbursement.object_cleanup_jobs WHERE object_key = $1`, key).Scan(&completed, &attempts); err != nil || completed == nil || attempts != 2 {
		t.Fatalf("completed task = %v, %d, %v", completed, attempts, err)
	}
	if len(objects.removed) != 1 || objects.removed[0] != key {
		t.Fatalf("removed=%#v", objects.removed)
	}
}

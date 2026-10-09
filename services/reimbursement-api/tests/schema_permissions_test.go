package tests

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAgentServiceCannotAccessReimbursementSchema(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)

	var schemaUsage bool
	if err := pool.QueryRow(context.Background(), `SELECT has_schema_privilege('agent_service', 'reimbursement', 'USAGE')`).Scan(&schemaUsage); err != nil {
		t.Fatalf("read agent schema privilege: %v", err)
	}
	if schemaUsage {
		t.Fatal("agent_service must not have USAGE on the reimbursement schema")
	}

	var tableSelect bool
	if err := pool.QueryRow(context.Background(), `SELECT has_table_privilege('agent_service', 'reimbursement.idempotency_records', 'SELECT')`).Scan(&tableSelect); err != nil {
		t.Fatalf("read agent table privilege: %v", err)
	}
	if tableSelect {
		t.Fatal("agent_service must not SELECT from reimbursement.idempotency_records")
	}

	var apiCanWrite bool
	if err := pool.QueryRow(context.Background(), `SELECT has_table_privilege('reimbursement_api', 'reimbursement.idempotency_records', 'INSERT')`).Scan(&apiCanWrite); err != nil {
		t.Fatalf("read reimbursement api privilege: %v", err)
	}
	if !apiCanWrite {
		t.Fatal("reimbursement_api must INSERT into reimbursement.idempotency_records")
	}
}

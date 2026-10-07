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

func TestPostgresLegacyImport_IsIdempotent(t *testing.T) {
	url := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL"); if url == "" { t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured") }
	ctx := context.Background(); pool, err := pgxpool.New(ctx, url); if err != nil { t.Fatal(err) }; t.Cleanup(pool.Close)
	suffix := time.Now().UTC().Format("20060102150405.000000000"); owner, id := "legacy-owner-"+suffix, "legacy-claim-"+suffix
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Legacy Import')`, owner); err != nil { t.Fatal(err) }
	service := application.NewLegacyImportService(NewPostgresLegacyImportRepository(pool))
	record := application.LegacyClaimImport{Claim: domain.Claim{ID:id, OwnerID:owner, Status:domain.ClaimStatusDraft, Purpose:"历史迁移", Version:1}}
	if _, err = service.Import(ctx, record); err != nil { t.Fatal(err) }; result, err := service.Import(ctx, record); if err != nil { t.Fatal(err) }
	if result.Skipped != 1 { t.Fatalf("result = %#v", result) }
}

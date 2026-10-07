package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresLegacyImportRepository intentionally performs no audit/outbox write:
// an import is historical data recovery, not a newly-created business action.
type PostgresLegacyImportRepository struct { pool *pgxpool.Pool }
func NewPostgresLegacyImportRepository(pool *pgxpool.Pool) *PostgresLegacyImportRepository { return &PostgresLegacyImportRepository{pool: pool} }

func (repository *PostgresLegacyImportRepository) InsertIfAbsent(ctx context.Context, record application.LegacyClaimImport) (bool, error) {
	participants, err := json.Marshal(record.Claim.Participants); if err != nil { return false, fmt.Errorf("encode participants: %w", err) }
	result, err := repository.pool.Exec(ctx, `
		INSERT INTO reimbursement.claims (id, owner_id, status, purpose, expense_category, participants, project_code, version, created_at, updated_at, submitted_at, submission_number)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),$6::jsonb,NULLIF($7,''),$8,$9,$10,CASE WHEN $3='SUBMITTED' THEN $10 ELSE NULL END,NULLIF($11,''))
		ON CONFLICT (id) DO NOTHING`, record.Claim.ID, record.Claim.OwnerID, record.Claim.Status, record.Claim.Purpose, record.Claim.ExpenseCategory, participants, record.Claim.ProjectCode, record.Claim.Version, record.Claim.CreatedAt, record.Claim.UpdatedAt, record.SubmissionNumber)
	if err != nil { return false, fmt.Errorf("insert legacy claim: %w", err) }
	return result.RowsAffected() == 1, nil
}

package store

import (
	"context"
	"fmt"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresClaimNumberGenerator struct {
	pool *pgxpool.Pool
}

func NewPostgresClaimNumberGenerator(pool *pgxpool.Pool) application.ClaimNumberGenerator {
	return &PostgresClaimNumberGenerator{pool: pool}
}

func (generator *PostgresClaimNumberGenerator) Next(ctx context.Context, at time.Time) (string, error) {
	var claimNumber string
	if err := generator.pool.QueryRow(ctx, `SELECT reimbursement.next_claim_number($1)`, at).Scan(&claimNumber); err != nil {
		return "", fmt.Errorf("allocate claim number: %w", err)
	}
	return claimNumber, nil
}

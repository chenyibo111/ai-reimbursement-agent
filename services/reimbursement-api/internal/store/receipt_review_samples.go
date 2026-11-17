package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresReceiptReviewSamples struct{ pool *pgxpool.Pool }

func NewPostgresReceiptReviewSamples(pool *pgxpool.Pool) *PostgresReceiptReviewSamples {
	return &PostgresReceiptReviewSamples{pool: pool}
}

func (reader *PostgresReceiptReviewSamples) RecentOCRConfidences(ctx context.Context, limit int) ([]float64, error) {
	if limit < 1 || limit > 500 {
		limit = 500
	}
	rows, err := reader.pool.Query(ctx, `SELECT ocr_confidence FROM reimbursement.receipts WHERE ocr_confidence > 0 AND status IN ('EXTRACTED','REVIEW_REQUIRED') ORDER BY updated_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]float64, 0)
	for rows.Next() {
		var confidence float64
		if err := rows.Scan(&confidence); err != nil {
			return nil, err
		}
		values = append(values, confidence)
	}
	return values, rows.Err()
}

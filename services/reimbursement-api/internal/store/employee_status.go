package store

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
)

func EmployeeIsActive(pool *pgxpool.Pool) func(context.Context, string) (bool, error) {
	return func(ctx context.Context, employeeID string) (bool, error) {
		var active bool
		err := pool.QueryRow(ctx, `SELECT is_active FROM reimbursement.employees WHERE id = $1`, employeeID).Scan(&active)
		return active, err
	}
}

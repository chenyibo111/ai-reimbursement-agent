package store

import (
	"context"
	"fmt"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresEmployeeIdentityRepository struct{ pool *pgxpool.Pool }

func NewPostgresEmployeeIdentityRepository(pool *pgxpool.Pool) *PostgresEmployeeIdentityRepository {
	return &PostgresEmployeeIdentityRepository{pool: pool}
}
func (repository *PostgresEmployeeIdentityRepository) ActiveEmployeeExists(ctx context.Context, employeeID string) (bool, error) {
	var exists bool
	err := repository.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM reimbursement.employees WHERE id=$1 AND is_active=true)`, employeeID).Scan(&exists)
	return exists, err
}
func (repository *PostgresEmployeeIdentityRepository) CountActiveEmployees(ctx context.Context) (int, error) {
	var count int
	err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.employees WHERE is_active=true`).Scan(&count)
	return count, err
}
func (repository *PostgresEmployeeIdentityRepository) UpsertEmployeeIdentity(ctx context.Context, command application.EmployeeIdentityCommand) error {
	var existingID string
	err := repository.pool.QueryRow(ctx, `SELECT id FROM reimbursement.employees WHERE feishu_user_id=$1`, command.FeishuOpenID).Scan(&existingID)
	if err == nil && existingID != command.EmployeeID {
		return fmt.Errorf("feishu open id is already bound")
	}
	if err != nil && err != pgx.ErrNoRows {
		return fmt.Errorf("find employee identity: %w", err)
	}
	_, err = repository.pool.Exec(ctx, `INSERT INTO reimbursement.employees (id,display_name,feishu_user_id,role,is_active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,feishu_user_id=EXCLUDED.feishu_user_id,role=EXCLUDED.role,is_active=EXCLUDED.is_active`, command.EmployeeID, command.DisplayName, command.FeishuOpenID, command.Role, command.IsActive)
	if err != nil {
		return fmt.Errorf("upsert reimbursement employee: %w", err)
	}
	return nil
}

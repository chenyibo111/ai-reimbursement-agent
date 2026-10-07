package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresEmployeeIdentityRepositoryUpsertsAndProtectsOpenIDBinding(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	repository := NewPostgresEmployeeIdentityRepository(pool)
	first := application.EmployeeIdentityCommand{EmployeeID: "identity-" + suffix, DisplayName: "初始姓名", FeishuOpenID: "ou-" + suffix, Role: "EMPLOYEE", IsActive: true}
	if err := repository.UpsertEmployeeIdentity(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	first.DisplayName = "更新姓名"
	first.Role = "ADMIN"
	first.IsActive = false
	if err := repository.UpsertEmployeeIdentity(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	var name, role string
	var active bool
	if err := pool.QueryRow(context.Background(), `SELECT display_name,role,is_active FROM reimbursement.employees WHERE id=$1`, first.EmployeeID).Scan(&name, &role, &active); err != nil {
		t.Fatal(err)
	}
	if name != "更新姓名" || role != "ADMIN" || active {
		t.Fatalf("unexpected identity %q %q %t", name, role, active)
	}
	if err := repository.UpsertEmployeeIdentity(context.Background(), application.EmployeeIdentityCommand{EmployeeID: "other-" + suffix, DisplayName: "其他", FeishuOpenID: first.FeishuOpenID, Role: "EMPLOYEE", IsActive: true}); err == nil {
		t.Fatal("expected foreign open-id binding rejection")
	}
}

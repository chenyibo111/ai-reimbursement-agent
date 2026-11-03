package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func reconciliationTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS public."Employee" (id text PRIMARY KEY, "displayName" text NOT NULL, "feishuUserId" text UNIQUE)`,
		`CREATE TABLE IF NOT EXISTS public."IdentityReconcileRef" (id text PRIMARY KEY, employee_id text NOT NULL REFERENCES public."Employee"(id), slot text NOT NULL, UNIQUE(employee_id,slot))`,
	} {
		if _, err := pool.Exec(context.Background(), ddl); err != nil {
			t.Fatal(err)
		}
	}
	return pool
}

func seedReconciliation(t *testing.T, pool *pgxpool.Pool) mapping {
	t.Helper()
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	m := mapping{TenantKey: "tenant-test", UserID: "u_" + suffix, CanonicalEmployeeID: "canonical-" + suffix, DuplicateEmployeeID: "duplicate-" + suffix, DuplicateAppID: "cli_bot", DuplicateOpenID: "ou_bot_" + suffix}
	for _, id := range []string{m.CanonicalEmployeeID, m.DuplicateEmployeeID} {
		openID := "ou_web_" + suffix
		if id == m.DuplicateEmployeeID {
			openID = m.DuplicateOpenID
		}
		if _, err := pool.Exec(ctx, `INSERT INTO public."Employee" (id,"displayName","feishuUserId") VALUES ($1,'测试',$2)`, id, openID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id,display_name,feishu_user_id,role,is_active) VALUES ($1,'测试',$2,'EMPLOYEE',true)`, id, openID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employee_members (tenant_key,user_id,employee_id) VALUES ($1,$2,$3)`, m.TenantKey, m.UserID, m.CanonicalEmployeeID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM public."IdentityReconcileRef" WHERE employee_id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.claim_audits WHERE claim_id=$1`, "claim-"+m.UserID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employee_identity_merges WHERE duplicate_employee_id=$1`, m.DuplicateEmployeeID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employee_identity_links WHERE tenant_key=$1 AND user_id=$2`, m.TenantKey, m.UserID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employee_members WHERE tenant_key=$1 AND user_id=$2`, m.TenantKey, m.UserID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.sso_web_sessions WHERE employee_id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID)
		_, _ = pool.Exec(ctx, `DELETE FROM public."Employee" WHERE id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID)
	})
	return m
}

func TestReconciliationPreviewAndApply(t *testing.T) {
	pool := reconciliationTestPool(t)
	m := seedReconciliation(t, pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO public."IdentityReconcileRef" (id,employee_id,slot) VALUES ($1,$2,'source')`, "ref-"+m.UserID, m.DuplicateEmployeeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claim_audits (claim_id,actor_id,action,claim_version) VALUES ($1,$2,'TEST',1)`, "claim-"+m.UserID, m.DuplicateEmployeeID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{m.CanonicalEmployeeID, m.DuplicateEmployeeID} {
		if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.sso_web_sessions (id_hash,employee_id,sid,encrypted_id_token,expires_at) VALUES ($1,$2,'test','test',now()+interval '1 day')`, "session-"+id, id); err != nil {
			t.Fatal(err)
		}
	}
	preview, err := reconcile(ctx, pool, m, false)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Applied || len(preview.References) == 0 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if len(preview.RetainedHistory) == 0 || preview.InvalidatedSessions != 2 {
		t.Fatalf("history or sessions missing from preview: %+v", preview)
	}
	var owner string
	if err := pool.QueryRow(ctx, `SELECT employee_id FROM public."IdentityReconcileRef" WHERE id=$1`, "ref-"+m.UserID).Scan(&owner); err != nil || owner != m.DuplicateEmployeeID {
		t.Fatalf("preview changed owner: %q %v", owner, err)
	}
	result, err := reconcile(ctx, pool, m, true)
	if err != nil || !result.Applied {
		t.Fatalf("apply failed: %+v %v", result, err)
	}
	if err := pool.QueryRow(ctx, `SELECT employee_id FROM public."IdentityReconcileRef" WHERE id=$1`, "ref-"+m.UserID).Scan(&owner); err != nil || owner != m.CanonicalEmployeeID {
		t.Fatalf("owner was not moved: %q %v", owner, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.employees WHERE id=$1 AND is_active=false AND feishu_user_id IS NULL`, m.DuplicateEmployeeID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate was not archived: %d %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.claim_audits WHERE claim_id=$1 AND actor_id=$2`, "claim-"+m.UserID, m.DuplicateEmployeeID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("original audit actor was changed: %d %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.sso_web_sessions WHERE employee_id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("web sessions were not revoked: %d %v", count, err)
	}
}

func TestReconciliationUniqueConflictRollsBack(t *testing.T) {
	pool := reconciliationTestPool(t)
	m := seedReconciliation(t, pool)
	ctx := context.Background()
	for _, id := range []string{m.CanonicalEmployeeID, m.DuplicateEmployeeID} {
		if _, err := pool.Exec(ctx, `INSERT INTO public."IdentityReconcileRef" (id,employee_id,slot) VALUES ($1,$2,'same')`, "ref-"+id, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reconcile(ctx, pool, m, true); err == nil {
		t.Fatal("unique conflict should refuse merge")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.employees WHERE id=$1`, m.DuplicateEmployeeID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rollback lost duplicate employee: %d %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.employee_identity_links WHERE app_id=$1 AND open_id=$2`, m.DuplicateAppID, m.DuplicateOpenID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback created link: %d %v", count, err)
	}
}

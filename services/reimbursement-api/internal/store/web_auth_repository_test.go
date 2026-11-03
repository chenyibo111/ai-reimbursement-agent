package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func webAuthTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(), `CREATE TABLE IF NOT EXISTS public."Employee" (id text PRIMARY KEY, "displayName" text NOT NULL, "feishuUserId" text UNIQUE)`); err != nil {
		t.Fatal(err)
	}
	return pool
}

func webAuthOpenID(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	openID := fmt.Sprintf("ou_go_auth_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.sso_web_sessions WHERE employee_id IN (SELECT id FROM reimbursement.employees WHERE feishu_user_id=$1)`, openID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE feishu_user_id=$1`, openID)
		_, _ = pool.Exec(ctx, `DELETE FROM public."Employee" WHERE "feishuUserId"=$1`, openID)
	})
	return openID
}

func TestWebAuthFirstLoginCreatesOneIdentityInBothTables(t *testing.T) {
	pool := webAuthTestPool(t)
	openID := webAuthOpenID(t, pool)
	repository := NewWebAuthRepository(pool)
	identity, err := repository.ResolveEmployee(context.Background(), openID, "测试成员", "EMPLOYEE")
	if err != nil {
		t.Fatal(err)
	}
	if identity.ID == "" || identity.DisplayName != "测试成员" || identity.Role != "EMPLOYEE" || !identity.IsActive {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	var publicID, goID string
	if err := pool.QueryRow(context.Background(), `SELECT id FROM public."Employee" WHERE "feishuUserId"=$1`, openID).Scan(&publicID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT id FROM reimbursement.employees WHERE feishu_user_id=$1`, openID).Scan(&goID); err != nil {
		t.Fatal(err)
	}
	if publicID != identity.ID || goID != identity.ID {
		t.Fatalf("identity IDs diverged: public=%q go=%q returned=%q", publicID, goID, identity.ID)
	}
	second, err := repository.ResolveEmployee(context.Background(), openID, "更新姓名", "ADMIN")
	if err != nil || second.ID != identity.ID || second.Role != "ADMIN" {
		t.Fatalf("repeat login should reuse ID and refresh Go role: %+v, %v", second, err)
	}
}

func TestCrossAppMemberUsesOneEmployeeID(t *testing.T) {
	pool := webAuthTestPool(t)
	ctx := context.Background()
	member := fmt.Sprintf("u_cross_app_%d", time.Now().UnixNano())
	repository := NewWebAuthRepository(pool)
	web, err := repository.ResolveMember(ctx, MemberIdentity{TenantKey: "tenant-test", UserID: member, AppID: "cli_sso", OpenID: "ou_web_" + member, DisplayName: "测试成员", Role: "EMPLOYEE"})
	if err != nil {
		t.Fatal(err)
	}
	bot, err := repository.ResolveMember(ctx, MemberIdentity{TenantKey: "tenant-test", UserID: member, AppID: "cli_bot", OpenID: "ou_bot_" + member, DisplayName: "测试成员"})
	if err != nil {
		t.Fatal(err)
	}
	if web.ID != bot.ID {
		t.Fatalf("same member split across applications: %q != %q", web.ID, bot.ID)
	}
	otherTenant, err := repository.ResolveMember(ctx, MemberIdentity{TenantKey: "other-tenant", UserID: member, AppID: "cli_other", OpenID: "ou_other_" + member, DisplayName: "同名成员"})
	if err != nil {
		t.Fatal(err)
	}
	if otherTenant.ID == web.ID {
		t.Fatal("different tenants were merged")
	}
}

func TestCrossAppMemberConcurrentFirstUse(t *testing.T) {
	pool := webAuthTestPool(t)
	ctx := context.Background()
	userID := fmt.Sprintf("u_concurrent_member_%d", time.Now().UnixNano())
	repository := NewWebAuthRepository(pool)
	start := make(chan struct{})
	results := make(chan EmployeeIdentity, 8)
	errors := make(chan error, 8)
	var workers sync.WaitGroup
	for index := 0; index < 8; index++ {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			member := MemberIdentity{TenantKey: "tenant-test", UserID: userID, AppID: "cli_bot", OpenID: "ou_bot_" + userID, DisplayName: "成员"}
			if index%2 == 0 {
				member.AppID = "cli_sso"
				member.OpenID = "ou_sso_" + userID
				member.Role = "EMPLOYEE"
			}
			resolved, err := repository.ResolveMember(ctx, member)
			results <- resolved
			errors <- err
		}(index)
	}
	close(start)
	workers.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var canonical string
	for result := range results {
		if canonical == "" {
			canonical = result.ID
		} else if canonical != result.ID {
			t.Fatalf("concurrent member split into %s and %s", canonical, result.ID)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employee_identity_links WHERE tenant_key='tenant-test' AND user_id=$1`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employee_members WHERE tenant_key='tenant-test' AND user_id=$1`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM public."Employee" WHERE id=$1`, canonical)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE id=$1`, canonical)
	})
}

func TestCrossAppMemberRejectsConflictingLegacyOwner(t *testing.T) {
	pool := webAuthTestPool(t)
	ctx := context.Background()
	member := fmt.Sprintf("u_conflict_%d", time.Now().UnixNano())
	repository := NewWebAuthRepository(pool)
	web, err := repository.ResolveMember(ctx, MemberIdentity{TenantKey: "tenant-test", UserID: member, AppID: "cli_sso", OpenID: "ou_web_" + member, DisplayName: "成员", Role: "EMPLOYEE"})
	if err != nil {
		t.Fatal(err)
	}
	legacyID, err := newWebAuthUUID()
	if err != nil {
		t.Fatal(err)
	}
	botOpenID := "ou_bot_" + member
	if _, err = pool.Exec(ctx, `INSERT INTO public."Employee" (id,"displayName","feishuUserId") VALUES ($1,'旧机器人员工',$2)`, legacyID, botOpenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees (id,display_name,feishu_user_id,role,is_active) VALUES ($1,'旧机器人员工',$2,'EMPLOYEE',true)`, legacyID, botOpenID); err != nil {
		t.Fatal(err)
	}
	if _, err = repository.ResolveMember(ctx, MemberIdentity{TenantKey: "tenant-test", UserID: member, AppID: "cli_bot", OpenID: botOpenID, DisplayName: "成员"}); !errors.Is(err, ErrEmployeeIdentityConflict) {
		t.Fatalf("legacy owner should require reconciliation: %v", err)
	}
	var owner string
	if err = pool.QueryRow(ctx, `SELECT employee_id FROM reimbursement.employee_members WHERE tenant_key='tenant-test' AND user_id=$1`, member).Scan(&owner); err != nil || owner != web.ID {
		t.Fatalf("canonical owner changed: %q %v", owner, err)
	}
}

func TestCrossAppMemberPreservesInactiveEmployee(t *testing.T) {
	pool := webAuthTestPool(t)
	ctx := context.Background()
	member := fmt.Sprintf("u_inactive_%d", time.Now().UnixNano())
	repository := NewWebAuthRepository(pool)
	web, err := repository.ResolveMember(ctx, MemberIdentity{TenantKey: "tenant-test", UserID: member, AppID: "cli_sso", OpenID: "ou_web_" + member, DisplayName: "成员", Role: "ADMIN"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE reimbursement.employees SET is_active=false WHERE id=$1`, web.ID); err != nil {
		t.Fatal(err)
	}
	bot, err := repository.ResolveMember(ctx, MemberIdentity{TenantKey: "tenant-test", UserID: member, AppID: "cli_bot", OpenID: "ou_bot_" + member, DisplayName: "成员"})
	if err != nil || bot.IsActive || bot.Role != "ADMIN" {
		t.Fatalf("bot reactivated employee or changed role: %+v %v", bot, err)
	}
}

func TestWebAuthReusesNextBFFEmployeeID(t *testing.T) {
	pool := webAuthTestPool(t)
	openID := webAuthOpenID(t, pool)
	existingID := fmt.Sprintf("next-employee-%d", time.Now().UnixNano())
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO public."Employee" (id,"displayName","feishuUserId") VALUES ($1,'原员工',$2)`, existingID, openID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id,display_name,feishu_user_id,role,is_active) VALUES ($1,'原员工',$2,'EMPLOYEE',true)`, existingID, openID); err != nil {
		t.Fatal(err)
	}
	identity, err := NewWebAuthRepository(pool).ResolveEmployee(ctx, openID, "新姓名", "FINANCE_REVIEWER")
	if err != nil || identity.ID != existingID || identity.Role != "FINANCE_REVIEWER" {
		t.Fatalf("existing Next employee must keep claim ownership: %+v, %v", identity, err)
	}
}

func TestWebAuthLoginDoesNotReactivateDisabledEmployee(t *testing.T) {
	pool := webAuthTestPool(t)
	openID := webAuthOpenID(t, pool)
	repository := NewWebAuthRepository(pool)
	first, err := repository.ResolveEmployee(context.Background(), openID, "测试成员", "EMPLOYEE")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE reimbursement.employees SET is_active=false WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := repository.ResolveEmployee(context.Background(), openID, "测试成员", "EMPLOYEE")
	if err != nil {
		t.Fatal(err)
	}
	if second.IsActive {
		t.Fatal("disabled employee was reactivated by SSO login")
	}
}

func TestWebAuthRejectsConflictingEmployeeIDs(t *testing.T) {
	pool := webAuthTestPool(t)
	openID := webAuthOpenID(t, pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO public."Employee" (id,"displayName","feishuUserId") VALUES ($1,'原员工',$2)`, "public-"+openID, openID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id,display_name,feishu_user_id,role,is_active) VALUES ($1,'原员工',$2,'EMPLOYEE',true)`, "go-"+openID, openID); err != nil {
		t.Fatal(err)
	}
	if _, err := NewWebAuthRepository(pool).ResolveEmployee(ctx, openID, "新姓名", "ADMIN"); err == nil {
		t.Fatal("different existing IDs must not be merged automatically")
	}
}

func TestWebAuthConcurrentFirstLoginUsesOneEmployeeID(t *testing.T) {
	pool := webAuthTestPool(t)
	openID := webAuthOpenID(t, pool)
	repository := NewWebAuthRepository(pool)
	start := make(chan struct{})
	results := make(chan EmployeeIdentity, 6)
	errors := make(chan error, 6)
	var group sync.WaitGroup
	for i := 0; i < 6; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			identity, err := repository.ResolveEmployee(context.Background(), openID, "并发成员", "EMPLOYEE")
			if err != nil {
				errors <- err
				return
			}
			results <- identity
		}()
	}
	close(start)
	group.Wait()
	close(results)
	close(errors)
	for err := range errors {
		t.Errorf("concurrent login failed: %v", err)
	}
	var first string
	for identity := range results {
		if first == "" {
			first = identity.ID
		}
		if identity.ID != first {
			t.Fatalf("concurrent login returned different IDs: %q and %q", first, identity.ID)
		}
	}
	if first == "" {
		t.Fatal("no concurrent login succeeded")
	}
}

func TestWebAuthSessionCRUDAndDeleteBySID(t *testing.T) {
	pool := webAuthTestPool(t)
	repository := NewWebAuthRepository(pool)
	openID := webAuthOpenID(t, pool)
	identity, err := repository.ResolveEmployee(context.Background(), openID, "会话成员", "EMPLOYEE")
	if err != nil {
		t.Fatal(err)
	}
	sid := fmt.Sprintf("sid-go-auth-%d", time.Now().UnixNano())
	hash := fmt.Sprintf("%064d", time.Now().UnixNano())
	record := SessionRecord{IDHash: hash, EmployeeID: identity.ID, SID: sid, EncryptedIDToken: "ciphertext", ExpiresAt: time.Now().Add(time.Hour)}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM reimbursement.sso_web_sessions WHERE sid=$1`, sid)
	})
	if err := repository.PutSession(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	loaded, err := repository.FindSession(context.Background(), hash)
	if err != nil || loaded == nil || loaded.SID != sid || loaded.EmployeeID != record.EmployeeID || loaded.EncryptedIDToken != record.EncryptedIDToken {
		t.Fatalf("session roundtrip failed: %+v, %v", loaded, err)
	}
	if err := repository.DeleteSessionsBySID(context.Background(), sid); err != nil {
		t.Fatal(err)
	}
	loaded, err = repository.FindSession(context.Background(), hash)
	if err != nil || loaded != nil {
		t.Fatalf("backchannel sid cleanup failed: %+v, %v", loaded, err)
	}
}

func TestWebAuthFindEmployeeByIDReturnsCurrentRoleAndActivity(t *testing.T) {
	pool := webAuthTestPool(t)
	openID := webAuthOpenID(t, pool)
	repository := NewWebAuthRepository(pool)
	identity, err := repository.ResolveEmployee(context.Background(), openID, "会话成员", "EMPLOYEE")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE reimbursement.employees SET role='ADMIN',is_active=false WHERE id=$1`, identity.ID); err != nil {
		t.Fatal(err)
	}
	current, err := repository.FindEmployeeByID(context.Background(), identity.ID)
	if err != nil || current == nil || current.ID != identity.ID || current.OpenID != openID || current.Role != "ADMIN" || current.IsActive {
		t.Fatalf("current employee status not loaded: %+v, %v", current, err)
	}
}

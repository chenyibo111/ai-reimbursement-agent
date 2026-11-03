package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// MemberIdentity contains only identifiers verified by the Feishu application
// named by AppID. Role is set by Web SSO; an empty role leaves an existing role
// unchanged for bot messages.
type MemberIdentity struct {
	TenantKey   string
	UserID      string
	AppID       string
	OpenID      string
	DisplayName string
	Role        string
}

var ErrEmployeeIdentityConflict = errors.New("employee identity conflict")

func (repository *WebAuthRepository) ResolveMember(ctx context.Context, member MemberIdentity) (EmployeeIdentity, error) {
	if strings.TrimSpace(member.TenantKey) == "" || strings.TrimSpace(member.UserID) == "" || strings.TrimSpace(member.AppID) == "" || !strings.HasPrefix(member.OpenID, "ou_") || strings.TrimSpace(member.DisplayName) == "" || (member.Role != "" && !validWebAuthRole(member.Role)) {
		return EmployeeIdentity{}, fmt.Errorf("invalid verified member identity")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return EmployeeIdentity{}, err
	}
	defer tx.Rollback(ctx)
	lockKey := fmt.Sprintf("%d:%s%s", len(member.TenantKey), member.TenantKey, member.UserID)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return EmployeeIdentity{}, err
	}
	var linkedTenant, linkedUser string
	err = tx.QueryRow(ctx, `SELECT tenant_key,user_id FROM reimbursement.employee_identity_links WHERE app_id=$1 AND open_id=$2`, member.AppID, member.OpenID).Scan(&linkedTenant, &linkedUser)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EmployeeIdentity{}, err
	}
	if err == nil && (linkedTenant != member.TenantKey || linkedUser != member.UserID) {
		return EmployeeIdentity{}, ErrEmployeeIdentityConflict
	}
	var canonicalID string
	err = tx.QueryRow(ctx, `SELECT employee_id FROM reimbursement.employee_members WHERE tenant_key=$1 AND user_id=$2`, member.TenantKey, member.UserID).Scan(&canonicalID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EmployeeIdentity{}, err
	}
	var publicID, goID string
	err = tx.QueryRow(ctx, `SELECT id FROM public."Employee" WHERE "feishuUserId"=$1`, member.OpenID).Scan(&publicID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EmployeeIdentity{}, err
	}
	err = tx.QueryRow(ctx, `SELECT id FROM reimbursement.employees WHERE feishu_user_id=$1`, member.OpenID).Scan(&goID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EmployeeIdentity{}, err
	}
	for _, legacyID := range []string{publicID, goID} {
		if legacyID == "" {
			continue
		}
		if canonicalID != "" && canonicalID != legacyID {
			return EmployeeIdentity{}, ErrEmployeeIdentityConflict
		}
		canonicalID = legacyID
	}
	if canonicalID == "" {
		canonicalID, err = newWebAuthUUID()
		if err != nil {
			return EmployeeIdentity{}, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO public."Employee" (id,"displayName") VALUES ($1,$2)
		ON CONFLICT (id) DO UPDATE SET "displayName"=EXCLUDED."displayName"`, canonicalID, member.DisplayName); err != nil {
		return EmployeeIdentity{}, err
	}
	role := member.Role
	if role == "" {
		role = "EMPLOYEE"
	}
	var savedRole string
	var isActive bool
	err = tx.QueryRow(ctx, `INSERT INTO reimbursement.employees (id,display_name,role,is_active) VALUES ($1,$2,$3,true)
		ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,
		role=CASE WHEN $4::boolean THEN EXCLUDED.role ELSE reimbursement.employees.role END
		RETURNING role,is_active`, canonicalID, member.DisplayName, role, member.Role != "").Scan(&savedRole, &isActive)
	if err != nil {
		return EmployeeIdentity{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.employee_members (tenant_key,user_id,employee_id) VALUES ($1,$2,$3)
		ON CONFLICT (tenant_key,user_id) DO NOTHING`, member.TenantKey, member.UserID, canonicalID); err != nil {
		return EmployeeIdentity{}, err
	}
	var savedID string
	if err = tx.QueryRow(ctx, `SELECT employee_id FROM reimbursement.employee_members WHERE tenant_key=$1 AND user_id=$2`, member.TenantKey, member.UserID).Scan(&savedID); err != nil {
		return EmployeeIdentity{}, err
	}
	if savedID != canonicalID {
		return EmployeeIdentity{}, ErrEmployeeIdentityConflict
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.employee_identity_links (app_id,open_id,tenant_key,user_id) VALUES ($1,$2,$3,$4)
		ON CONFLICT (app_id,open_id) DO NOTHING`, member.AppID, member.OpenID, member.TenantKey, member.UserID); err != nil {
		return EmployeeIdentity{}, err
	}
	if err = tx.QueryRow(ctx, `SELECT tenant_key,user_id FROM reimbursement.employee_identity_links WHERE app_id=$1 AND open_id=$2`, member.AppID, member.OpenID).Scan(&linkedTenant, &linkedUser); err != nil {
		return EmployeeIdentity{}, err
	}
	if linkedTenant != member.TenantKey || linkedUser != member.UserID {
		return EmployeeIdentity{}, ErrEmployeeIdentityConflict
	}
	if err = tx.Commit(ctx); err != nil {
		return EmployeeIdentity{}, err
	}
	return EmployeeIdentity{ID: canonicalID, OpenID: member.OpenID, DisplayName: member.DisplayName, Role: savedRole, IsActive: isActive}, nil
}

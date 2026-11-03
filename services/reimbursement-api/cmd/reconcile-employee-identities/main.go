// reconcile-employee-identities moves legacy references only after Feishu has
// verified that the duplicate app open_id belongs to the canonical tenant user.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type mapping struct {
	TenantKey           string `json:"tenantKey"`
	UserID              string `json:"userId"`
	CanonicalEmployeeID string `json:"canonicalEmployeeId"`
	DuplicateEmployeeID string `json:"duplicateEmployeeId"`
	DuplicateAppID      string `json:"duplicateAppId"`
	DuplicateOpenID     string `json:"duplicateOpenId"`
}

type reference struct {
	Schema string `json:"schema"`
	Table  string `json:"table"`
	Column string `json:"column"`
	Count  int64  `json:"count"`
}

type report struct {
	TenantKey           string      `json:"tenantKey"`
	UserID              string      `json:"userId"`
	CanonicalEmployeeID string      `json:"canonicalEmployeeId"`
	DuplicateEmployeeID string      `json:"duplicateEmployeeId"`
	References          []reference `json:"references"`
	RetainedHistory     []reference `json:"retainedHistory"`
	InvalidatedSessions int64       `json:"invalidatedSessions"`
	Applied             bool        `json:"applied"`
}

func main() {
	path := flag.String("mapping", "", "path to a reviewed single-member JSON mapping")
	apply := flag.Bool("apply", false, "apply the reviewed mapping")
	backup := flag.Bool("backup-confirmed", false, "confirm a restorable database backup exists")
	flag.Parse()
	if err := run(context.Background(), *path, *apply, *backup); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, path string, apply, backup bool) error {
	if path == "" || (apply && !backup) {
		return errors.New("--mapping is required; --apply also requires --backup-confirmed")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var m mapping
	if err = json.Unmarshal(data, &m); err != nil {
		return err
	}
	if m.TenantKey == "" || m.UserID == "" || m.CanonicalEmployeeID == "" || m.DuplicateEmployeeID == "" || m.CanonicalEmployeeID == m.DuplicateEmployeeID || m.DuplicateAppID == "" || !strings.HasPrefix(m.DuplicateOpenID, "ou_") {
		return errors.New("mapping is incomplete or contains the same employee twice")
	}
	if m.TenantKey != os.Getenv("FEISHU_TENANT_KEY") || m.DuplicateAppID != os.Getenv("RECONCILE_FEISHU_APP_ID") {
		return errors.New("mapping does not match configured Feishu tenant and application")
	}
	verified, err := lookupUserID(ctx, m.DuplicateOpenID)
	if err != nil {
		return fmt.Errorf("Feishu identity verification failed: %w", err)
	}
	if verified != m.UserID {
		return errors.New("Feishu user_id does not match the canonical member")
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return errors.New("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	r, err := reconcile(ctx, pool, m, apply)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(r)
}

func lookupUserID(ctx context.Context, openID string) (string, error) {
	appID, secret := os.Getenv("RECONCILE_FEISHU_APP_ID"), os.Getenv("RECONCILE_FEISHU_APP_SECRET")
	if appID == "" || secret == "" {
		return "", errors.New("reconciliation app credentials are required")
	}
	client := &http.Client{Timeout: 10 * time.Second}
	body, _ := json.Marshal(map[string]string{"app_id": appID, "app_secret": secret})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var token struct {
		Code  int    `json:"code"`
		Token string `json:"tenant_access_token"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&token) != nil || token.Code != 0 || token.Token == "" {
		return "", errors.New("tenant token unavailable")
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, "https://open.feishu.cn/open-apis/contact/v3/users/"+url.PathEscape(openID)+"?user_id_type=open_id", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token.Token)
	resp, err = client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var user struct {
		Code int `json:"code"`
		Data struct {
			User struct {
				OpenID string `json:"open_id"`
				UserID string `json:"user_id"`
			} `json:"user"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&user) != nil || user.Code != 0 || user.Data.User.OpenID != openID || user.Data.User.UserID == "" {
		return "", errors.New("member lookup unavailable")
	}
	return user.Data.User.UserID, nil
}

func reconcile(ctx context.Context, pool *pgxpool.Pool, m mapping, apply bool) (report, error) {
	r := report{TenantKey: m.TenantKey, UserID: m.UserID, CanonicalEmployeeID: m.CanonicalEmployeeID, DuplicateEmployeeID: m.DuplicateEmployeeID, References: []reference{}, RetainedHistory: []reference{}}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)
	var memberID string
	if err = tx.QueryRow(ctx, `SELECT employee_id FROM reimbursement.employee_members WHERE tenant_key=$1 AND user_id=$2 FOR UPDATE`, m.TenantKey, m.UserID).Scan(&memberID); err != nil || memberID != m.CanonicalEmployeeID {
		return r, errors.New("canonical member binding is missing or mismatched")
	}
	var other string
	err = tx.QueryRow(ctx, `SELECT tenant_key FROM reimbursement.employee_members WHERE employee_id=$1`, m.DuplicateEmployeeID).Scan(&other)
	if err == nil {
		return r, errors.New("duplicate employee is already bound to a member")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return r, err
	}
	for _, table := range []string{`public."Employee"`, `reimbursement.employees`} {
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID).Scan(&count); err != nil {
			return r, err
		}
		if count != 2 {
			return r, fmt.Errorf("both employee rows must exist in %s", table)
		}
	}
	var legacyCount int
	if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM public."Employee" WHERE id=$1 AND "feishuUserId"=$2) + (SELECT count(*) FROM reimbursement.employees WHERE id=$1 AND feishu_user_id=$2)`, m.DuplicateEmployeeID, m.DuplicateOpenID).Scan(&legacyCount); err != nil {
		return r, err
	}
	if legacyCount == 0 {
		return r, errors.New("duplicate open_id is not attached to the specified employee")
	}
	var inactive bool
	if err = tx.QueryRow(ctx, `SELECT bool_or(NOT is_active) FROM reimbursement.employees WHERE id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID).Scan(&inactive); err != nil {
		return r, err
	}
	if inactive {
		return r, errors.New("inactive employee requires manual review")
	}
	var roleCount int
	if err = tx.QueryRow(ctx, `SELECT count(DISTINCT role) FROM reimbursement.employees WHERE id IN ($1,$2)`, m.CanonicalEmployeeID, m.DuplicateEmployeeID).Scan(&roleCount); err != nil {
		return r, err
	}
	if roleCount != 1 {
		return r, errors.New("employee roles differ and require manual review")
	}
	var linkedTenant, linkedUser string
	err = tx.QueryRow(ctx, `SELECT tenant_key,user_id FROM reimbursement.employee_identity_links WHERE app_id=$1 AND open_id=$2`, m.DuplicateAppID, m.DuplicateOpenID).Scan(&linkedTenant, &linkedUser)
	if err == nil && (linkedTenant != m.TenantKey || linkedUser != m.UserID) {
		return r, errors.New("duplicate app identity belongs to a different member")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return r, err
	}
	refs, err := employeeReferences(ctx, tx)
	if err != nil {
		return r, err
	}
	sessionTables := []reference{{Schema: "reimbursement", Table: "sso_web_sessions", Column: "employee_id"}}
	var legacySessionTable bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sso_web_sessions' AND column_name='employee_id')`).Scan(&legacySessionTable); err != nil {
		return r, err
	}
	if legacySessionTable {
		sessionTables = append(sessionTables, reference{Schema: "public", Table: "sso_web_sessions", Column: "employee_id"})
	}
	for _, ref := range refs {
		query := `SELECT count(*) FROM ` + pgx.Identifier{ref.Schema, ref.Table}.Sanitize() + ` WHERE ` + pgx.Identifier{ref.Column}.Sanitize() + `=$1`
		if err = tx.QueryRow(ctx, query, m.DuplicateEmployeeID).Scan(&ref.Count); err != nil {
			return r, err
		}
		if ref.Count > 0 {
			if historicalReference(ref) {
				r.RetainedHistory = append(r.RetainedHistory, ref)
			} else {
				r.References = append(r.References, ref)
			}
		}
	}
	for _, table := range sessionTables {
		var count int64
		query := `SELECT count(*) FROM ` + pgx.Identifier{table.Schema, table.Table}.Sanitize() + ` WHERE employee_id IN ($1,$2)`
		if err = tx.QueryRow(ctx, query, m.CanonicalEmployeeID, m.DuplicateEmployeeID).Scan(&count); err != nil {
			return r, err
		}
		r.InvalidatedSessions += count
	}
	if !apply {
		return r, nil
	}
	// Invalidate both sides before moving any reference; old sessions contain a
	// signed token for an identity that may have changed during reconciliation.
	for _, table := range sessionTables {
		query := `DELETE FROM ` + pgx.Identifier{table.Schema, table.Table}.Sanitize() + ` WHERE employee_id IN ($1,$2)`
		if _, err = tx.Exec(ctx, query, m.CanonicalEmployeeID, m.DuplicateEmployeeID); err != nil {
			return r, err
		}
	}
	for _, ref := range refs {
		if historicalReference(ref) {
			continue
		}
		query := `UPDATE ` + pgx.Identifier{ref.Schema, ref.Table}.Sanitize() + ` SET ` + pgx.Identifier{ref.Column}.Sanitize() + `=$1 WHERE ` + pgx.Identifier{ref.Column}.Sanitize() + `=$2`
		if _, err = tx.Exec(ctx, query, m.CanonicalEmployeeID, m.DuplicateEmployeeID); err != nil {
			return r, fmt.Errorf("reference conflict at %s.%s.%s: %w", ref.Schema, ref.Table, ref.Column, err)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.employee_identity_links (app_id,open_id,tenant_key,user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (app_id,open_id) DO NOTHING`, m.DuplicateAppID, m.DuplicateOpenID, m.TenantKey, m.UserID); err != nil {
		return r, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.employee_identity_merges (duplicate_employee_id,canonical_employee_id,tenant_key,user_id,app_id,open_id) VALUES ($1,$2,$3,$4,$5,$6)`, m.DuplicateEmployeeID, m.CanonicalEmployeeID, m.TenantKey, m.UserID, m.DuplicateAppID, m.DuplicateOpenID); err != nil {
		return r, err
	}
	if _, err = tx.Exec(ctx, `UPDATE public."Employee" SET "feishuUserId"=NULL WHERE id=$1`, m.DuplicateEmployeeID); err != nil {
		return r, err
	}
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.employees SET feishu_user_id=NULL,is_active=false WHERE id=$1`, m.DuplicateEmployeeID); err != nil {
		return r, err
	}
	if err = tx.Commit(ctx); err != nil {
		return r, err
	}
	r.Applied = true
	return r, nil
}

func historicalReference(ref reference) bool {
	if ref.Schema == "reimbursement" {
		switch ref.Table {
		case "claim_audits", "receipt_audits", "review_case_audits", "submission_snapshots", "policy_versions", "employee_identity_merges":
			return true
		case "review_cases":
			return ref.Column == "resolved_by"
		}
	}
	if ref.Schema == "public" {
		switch ref.Table {
		case "AuditEvent", "PolicyAuditEvent", "PolicyVersion", "PolicySource":
			return true
		}
	}
	return false
}

func employeeReferences(ctx context.Context, tx pgx.Tx) ([]reference, error) {
	rows, err := tx.Query(ctx, `SELECT n.nspname,c.relname,a.attname FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.conkey[1] WHERE k.contype='f' AND array_length(k.conkey,1)=1 AND k.confrelid IN ('public."Employee"'::regclass,'reimbursement.employees'::regclass)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	refs := map[string]reference{}
	for rows.Next() {
		var ref reference
		if err = rows.Scan(&ref.Schema, &ref.Table, &ref.Column); err != nil {
			return nil, err
		}
		if ref.Schema == "reimbursement" && (ref.Table == "sso_web_sessions" || ref.Table == "employee_members") {
			continue
		}
		refs[ref.Schema+"."+ref.Table+"."+ref.Column] = ref
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	// Older Agent and policy tables store employee IDs without FK constraints.
	for _, ref := range []reference{{Schema: "public", Table: "AgentClaimNotificationTarget", Column: "employeeId"}, {Schema: "public", Table: "PolicyVersion", Column: "createdByEmployeeId"}, {Schema: "public", Table: "PolicyVersion", Column: "publishedByEmployeeId"}, {Schema: "public", Table: "PolicySource", Column: "createdByEmployeeId"}, {Schema: "public", Table: "PolicyAuditEvent", Column: "actorId"}, {Schema: "public", Table: "AuditEvent", Column: "actorId"}, {Schema: "reimbursement", Table: "idempotency_keys", Column: "actor_id"}} {
		var exists bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3)`, ref.Schema, ref.Table, ref.Column).Scan(&exists)
		if err != nil {
			return nil, err
		}
		if exists {
			refs[ref.Schema+"."+ref.Table+"."+ref.Column] = ref
		}
	}
	result := make([]reference, 0, len(refs))
	for _, ref := range refs {
		result = append(result, ref)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Schema+result[i].Table+result[i].Column < result[j].Schema+result[j].Table+result[j].Column
	})
	return result, nil
}

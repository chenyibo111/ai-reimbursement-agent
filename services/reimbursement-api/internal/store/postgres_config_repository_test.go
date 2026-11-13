package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresConfigRepositoryRevisionPublishAndRollback(t *testing.T) {
	url := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE reimbursement.config_audit, reimbursement.config_active_versions, reimbursement.config_versions, reimbursement.config_drafts`); err != nil {
		t.Fatal(err)
	}
	repo := NewPostgresConfigRepository(pool)
	first, err := repo.SaveDraft(ctx, "admin-1", "expense_catalog", 0, json.RawMessage(`{"name":"first"}`), "initial")
	if err != nil || first.Revision != 1 {
		t.Fatalf("save first draft: %+v %v", first, err)
	}
	if _, err := repo.SaveDraft(ctx, "admin-2", "expense_catalog", 0, json.RawMessage(`{"name":"lost"}`), "stale"); !errors.Is(err, application.ErrConfigConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	published, err := repo.PublishDraft(ctx, "admin-1", "expense_catalog", 1)
	if err != nil || published.Version != 1 || configName(t, published.Payload) != "first" {
		t.Fatalf("publish first: %+v %v", published, err)
	}
	publishedDraft, err := repo.GetDraft(ctx, "expense_catalog")
	if err != nil || publishedDraft.PublishedRevision != 1 {
		t.Fatalf("published draft revision: %+v %v", publishedDraft, err)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "expense_catalog", 1); !errors.Is(err, application.ErrConfigConflict) {
		t.Fatalf("repeated publish created another version: %v", err)
	}
	if _, err := repo.SaveDraft(ctx, "admin-1", "form_options", 0, json.RawMessage(`{"name":"other domain"}`), "separate"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "form_options", 1); err != nil {
		t.Fatal(err)
	}
	second, err := repo.SaveDraft(ctx, "admin-1", "expense_catalog", 1, json.RawMessage(`{"name":"second"}`), "update")
	if err != nil || second.Revision != 2 {
		t.Fatalf("save second: %+v %v", second, err)
	}
	if second.PublishedRevision != 1 {
		t.Fatalf("saving a new draft changed published revision: %+v", second)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "expense_catalog", 1); !errors.Is(err, application.ErrConfigConflict) {
		t.Fatalf("expected stale publish conflict, got %v", err)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "expense_catalog", 2); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ActivateVersion(ctx, "admin-2", "expense_catalog", 1, 1, "stale revert"); !errors.Is(err, application.ErrConfigConflict) {
		t.Fatalf("expected active pointer conflict, got %v", err)
	}
	active, err := repo.ActivateVersion(ctx, "admin-2", "expense_catalog", 2, 1, "revert")
	if err != nil || active.Version != 1 {
		t.Fatalf("activate old version: %+v %v", active, err)
	}
	rolledBackDraft, err := repo.GetDraft(ctx, "expense_catalog")
	if err != nil || rolledBackDraft.Revision != 2 || rolledBackDraft.PublishedRevision != 2 {
		t.Fatalf("rollback should leave the published draft identifiable: %+v %v", rolledBackDraft, err)
	}
	current, err := repo.GetActive(ctx, "expense_catalog")
	if err != nil || configName(t, current.Payload) != "first" {
		t.Fatalf("old snapshot changed: %+v %v", current, err)
	}
	otherDomain, err := repo.GetActive(ctx, "form_options")
	if err != nil || configName(t, otherDomain.Payload) != "other domain" {
		t.Fatalf("cross-domain read: %+v %v", otherDomain, err)
	}
	var historyCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.config_audit WHERE domain='expense_catalog'`).Scan(&historyCount); err != nil || historyCount != 5 {
		t.Fatalf("audit count %d: %v", historyCount, err)
	}
}

func configName(t *testing.T, payload json.RawMessage) string {
	t.Helper()
	var value struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatal(err)
	}
	return value.Name
}

func TestPostgresConfigRepositoryRequiresIndependentApprovalForRiskyDomain(t *testing.T) {
	url := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE reimbursement.config_audit, reimbursement.config_active_versions, reimbursement.config_versions, reimbursement.config_drafts`); err != nil {
		t.Fatal(err)
	}
	repo := NewPostgresConfigRepository(pool)
	if _, err := repo.SaveDraft(ctx, "admin-1", "receipt_review", 0, json.RawMessage(`{"threshold":0.7}`), "risk"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApproveDraft(ctx, "admin-1", "receipt_review", 1); !errors.Is(err, application.ErrConfigApproval) {
		t.Fatalf("self approval allowed: %v", err)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "receipt_review", 1); !errors.Is(err, application.ErrConfigApproval) {
		t.Fatalf("unapproved publish allowed: %v", err)
	}
	if _, err := repo.ApproveDraft(ctx, "admin-2", "receipt_review", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "receipt_review", 1); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresConfigRepositoryPublishRollsBackWhenAuditFails(t *testing.T) {
	url := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE reimbursement.config_audit, reimbursement.config_active_versions, reimbursement.config_versions, reimbursement.config_drafts`); err != nil {
		t.Fatal(err)
	}
	repo := NewPostgresConfigRepository(pool)
	if _, err := repo.SaveDraft(ctx, "admin-1", "expense_catalog", 0, json.RawMessage(`{"name":"before"}`), "initial"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.PublishDraft(ctx, "admin-1", "expense_catalog", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SaveDraft(ctx, "admin-1", "expense_catalog", 1, json.RawMessage(`{"name":"after"}`), "update"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reimbursement.fail_config_audit_test() RETURNS trigger AS $$ BEGIN IF NEW.action='PUBLISHED' THEN RAISE EXCEPTION 'audit failure test'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
		CREATE TRIGGER fail_config_audit_test BEFORE INSERT ON reimbursement.config_audit FOR EACH ROW EXECUTE FUNCTION reimbursement.fail_config_audit_test()`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, `DROP TRIGGER IF EXISTS fail_config_audit_test ON reimbursement.config_audit; DROP FUNCTION IF EXISTS reimbursement.fail_config_audit_test()`)
	}()
	if _, err := repo.PublishDraft(ctx, "admin-1", "expense_catalog", 2); err == nil {
		t.Fatal("publish succeeded despite audit failure")
	}
	active, err := repo.GetActive(ctx, "expense_catalog")
	if err != nil || active.Version != 1 || configName(t, active.Payload) != "before" {
		t.Fatalf("active changed after failed transaction: %+v %v", active, err)
	}
	var versions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.config_versions WHERE domain='expense_catalog'`).Scan(&versions); err != nil || versions != 1 {
		t.Fatalf("versions=%d err=%v", versions, err)
	}
}

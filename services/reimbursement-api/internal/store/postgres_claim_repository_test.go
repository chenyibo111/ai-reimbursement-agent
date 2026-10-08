package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresClaimRepositoryWritesAuditAndOutboxAtomically(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	ownerID := "test-claim-owner-" + suffix
	claimID := "test-claim-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Claim Repository Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	service := application.NewClaimService(NewPostgresClaimRepository(pool), fixedIDGenerator{value: claimID}, NewPostgresClaimNumberGenerator(pool), time.Now)
	claim, err := service.CreateClaim(ctx, ownerID, application.CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	participants := []string{"employee-1", "employee-2"}
	updated, err := service.UpdateClaim(ctx, ownerID, claim.ID, claim.Version, application.PatchClaimCommand{Participants: &participants})
	if err != nil {
		t.Fatalf("update claim: %v", err)
	}
	if err := service.DeleteClaim(ctx, ownerID, updated.ID, updated.Version); err != nil {
		t.Fatalf("delete claim: %v", err)
	}

	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.claim_audits WHERE claim_id = $1`, claim.ID).Scan(&audits); err != nil {
		t.Fatalf("count audits: %v", err)
	}
	if audits != 3 {
		t.Fatalf("expected three audit records, got %d", audits)
	}
	var events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.outbox_events WHERE aggregate_id = $1`, claim.ID).Scan(&events); err != nil {
		t.Fatalf("count outbox events: %v", err)
	}
	if events != 3 {
		t.Fatalf("expected three outbox events, got %d", events)
	}
}

func TestPostgresClaimRepositoryReadsClaimApplicationDefaults(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	ownerID := "test-application-owner-" + suffix
	claimID := "test-application-claim-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'Application Fields Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	service := application.NewClaimService(NewPostgresClaimRepository(pool), fixedIDGenerator{value: claimID}, NewPostgresClaimNumberGenerator(pool), time.Now)
	claim, err := service.CreateClaim(ctx, ownerID, application.CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	reloaded, err := service.GetClaim(ctx, ownerID, claim.ID)
	if err != nil {
		t.Fatalf("reload claim: %v", err)
	}
	if reloaded.Currency != domain.ClaimCurrencyCNY || reloaded.RequestedAmountSource != domain.RequestedAmountSourceSuggested || reloaded.RequestedAmountCent != nil {
		t.Fatalf("application defaults = %#v", reloaded)
	}
}

func TestPostgresClaimRepositoryRefreshesOCRSuggestionWithoutOverwritingManualAmount(t *testing.T) {
	databaseURL := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)

	suffix := time.Now().UTC().Format("20060102150405.000000000")
	ownerID := "test-ocr-suggestion-owner-" + suffix
	claimID := "test-ocr-suggestion-claim-" + suffix
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.employees (id, display_name) VALUES ($1, 'OCR Suggestion Repository Test')`, ownerID); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'OCR suggested amount')`, claimID, ownerID); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	for index, amount := range []*int64{suggestionInt64Pointer(10155), suggestionInt64Pointer(2000), nil} {
		receiptID := fmt.Sprintf("test-ocr-suggestion-receipt-%s-%d", suffix, index)
		if _, err = pool.Exec(ctx, `
			INSERT INTO reimbursement.receipts (id, claim_id, owner_id, filename, content_type, expected_size, object_key, content_hash, status, total_amount_cent, ocr_confidence)
			VALUES ($1, $2, $3, 'invoice.png', 'image/png', 12, $4, $5, 'EXTRACTED', $6, 0.98)
		`, receiptID, claimID, ownerID, "test/"+receiptID, "hash-"+receiptID, amount); err != nil {
			t.Fatalf("seed extracted receipt %d: %v", index, err)
		}
	}

	repository := NewPostgresClaimRepository(pool)
	if err = repository.RefreshOCRSuggestion(ctx, claimID, ownerID); err != nil {
		t.Fatalf("refresh initial OCR suggestion: %v", err)
	}
	claim, err := repository.FindOwned(ctx, claimID, ownerID)
	if err != nil {
		t.Fatalf("read OCR suggested claim: %v", err)
	}
	if claim.RequestedAmountCent == nil || *claim.RequestedAmountCent != 12155 || claim.RequestedAmountSource != domain.RequestedAmountSourceSuggested {
		t.Fatalf("initial OCR suggestion = %#v", claim)
	}

	if _, err = pool.Exec(ctx, `UPDATE reimbursement.claims SET requested_amount_cent = 9999, requested_amount_source = 'MANUAL', version = version + 1 WHERE id = $1`, claimID); err != nil {
		t.Fatalf("set manual amount: %v", err)
	}
	if err = repository.RefreshOCRSuggestion(ctx, claimID, ownerID); err != nil {
		t.Fatalf("refresh after manual amount: %v", err)
	}
	claim, err = repository.FindOwned(ctx, claimID, ownerID)
	if err != nil {
		t.Fatalf("read manual claim: %v", err)
	}
	if claim.RequestedAmountCent == nil || *claim.RequestedAmountCent != 9999 || claim.RequestedAmountSource != domain.RequestedAmountSourceManual {
		t.Fatalf("manual amount was overwritten: %#v", claim)
	}

	if _, err = pool.Exec(ctx, `UPDATE reimbursement.claims SET requested_amount_cent = NULL, requested_amount_source = 'OCR_SUGGESTED', version = version + 1 WHERE id = $1`, claimID); err != nil {
		t.Fatalf("restore OCR source: %v", err)
	}
	if err = repository.RefreshOCRSuggestion(ctx, claimID, ownerID); err != nil {
		t.Fatalf("refresh restored OCR suggestion: %v", err)
	}
	claim, err = repository.FindOwned(ctx, claimID, ownerID)
	if err != nil {
		t.Fatalf("read restored suggestion: %v", err)
	}
	if claim.RequestedAmountCent == nil || *claim.RequestedAmountCent != 12155 || claim.RequestedAmountSource != domain.RequestedAmountSourceSuggested {
		t.Fatalf("restored OCR suggestion = %#v", claim)
	}

	var auditCount, eventCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.claim_audits WHERE claim_id = $1 AND action = 'CLAIM_OCR_SUGGESTION_REFRESHED'`, claimID).Scan(&auditCount); err != nil {
		t.Fatalf("count suggestion audits: %v", err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM reimbursement.outbox_events WHERE aggregate_id = $1 AND event_type = 'ClaimOCRSuggestionRefreshed'`, claimID).Scan(&eventCount); err != nil {
		t.Fatalf("count suggestion events: %v", err)
	}
	if auditCount != 2 || eventCount != 2 {
		t.Fatalf("suggestion audit/event counts = %d/%d, want 2/2", auditCount, eventCount)
	}

	emptyClaimID := "test-ocr-suggestion-empty-" + suffix
	if _, err = pool.Exec(ctx, `INSERT INTO reimbursement.claims (id, owner_id, purpose) VALUES ($1, $2, 'No OCR total')`, emptyClaimID, ownerID); err != nil {
		t.Fatalf("seed empty suggestion claim: %v", err)
	}
	if err = repository.RefreshOCRSuggestion(ctx, emptyClaimID, ownerID); err != nil {
		t.Fatalf("refresh empty OCR suggestion: %v", err)
	}
	emptyClaim, err := repository.FindOwned(ctx, emptyClaimID, ownerID)
	if err != nil {
		t.Fatalf("read empty suggestion claim: %v", err)
	}
	if emptyClaim.RequestedAmountCent != nil || emptyClaim.RequestedAmountSource != domain.RequestedAmountSourceSuggested || emptyClaim.Version != 1 {
		t.Fatalf("empty OCR suggestion changed claim: %#v", emptyClaim)
	}
}

func suggestionInt64Pointer(value int64) *int64 { return &value }

type fixedIDGenerator struct{ value string }

func (generator fixedIDGenerator) Next() string { return generator.value }

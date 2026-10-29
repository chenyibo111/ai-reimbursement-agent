package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5/pgxpool"
)

type policyTestClock struct{ now time.Time }

func (clock policyTestClock) Now() time.Time { return clock.now }

func TestPostgresPolicyVersionInvalidatesSubmissionAndBlocksNewRequest(t *testing.T) {
	url := os.Getenv("TEST_REIMBURSEMENT_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_REIMBURSEMENT_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	actor, claimID, receiptID := "policy-admin-"+suffix, "policy-claim-"+suffix, "policy-receipt-"+suffix
	policy1, policy2, policy3, futurePolicy := "policy-one-"+suffix, "policy-two-"+suffix, "policy-three-"+suffix, "policy-future-"+suffix
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.submission_snapshots WHERE claim_id=$1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.submission_confirmations WHERE claim_id=$1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.outbox_events WHERE aggregate_id=$1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.claim_audits WHERE claim_id=$1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.policy_versions WHERE id IN ($1,$2,$3,$4)`, policy1, policy2, policy3, futurePolicy)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.receipts WHERE id=$1`, receiptID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.claims WHERE id=$1`, claimID)
		_, _ = pool.Exec(ctx, `DELETE FROM reimbursement.employees WHERE id=$1`, actor)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.employees (id,display_name,role) VALUES ($1,'Policy test','ADMIN')`, actor); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.claims (id,owner_id,purpose,requested_amount_cent,requested_amount_source) VALUES ($1,$2,'Policy test claim',12000,'MANUAL')`, claimID, actor); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reimbursement.receipts (id,claim_id,owner_id,filename,content_type,expected_size,object_key,status,ocr_confidence) VALUES ($1,$2,$3,'invoice.png','image/png',1,$4,'EXTRACTED',0.99)`, receiptID, claimID, actor, "test/"+receiptID); err != nil {
		t.Fatal(err)
	}
	rules := func(limit int64) []application.PolicyRule {
		config, _ := json.Marshal(map[string]int64{"maxAmountCents": limit})
		return []application.PolicyRule{{Code: "TOTAL", Name: "整单限额", Type: "CLAIM_TOTAL_MAX", Severity: "BLOCKING", Config: config}}
	}
	publisher := application.NewPolicyRuleService(NewPostgresPolicyRuleRepository(pool))
	clock := policyTestClock{now: time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)}
	service := application.NewSubmissionService(NewPostgresSubmissionRepository(pool), clock)
	if err := publisher.Publish(actor, application.PolicyVersion{ID: policy1, EffectiveDate: "2026-10-01", Rules: rules(15000)}); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(actor, application.PolicyVersion{ID: policy1, EffectiveDate: "2026-10-01", Rules: rules(10000)}); !errors.Is(err, application.ErrPolicyVersionExists) {
		t.Fatalf("duplicate policy version should return a domain conflict, got %v", err)
	}
	confirmation, err := service.RequestSubmission(ctx, actor, claimID, 1)
	if err != nil || confirmation.PolicyVersion != policy1 {
		t.Fatalf("confirmation=%#v err=%v", confirmation, err)
	}
	if err := publisher.Publish(actor, application.PolicyVersion{ID: futurePolicy, EffectiveDate: "2026-11-01", Rules: rules(5000)}); err != nil {
		t.Fatal(err)
	}
	beforeFuture, err := service.ValidateClaim(ctx, actor, claimID)
	if err != nil || beforeFuture.PolicyVersion != policy1 || len(beforeFuture.Issues) != 0 {
		t.Fatalf("future version applied early: %#v err=%v", beforeFuture, err)
	}
	if err := publisher.Publish(actor, application.PolicyVersion{ID: policy2, EffectiveDate: "2026-10-02", Rules: rules(10000)}); err != nil {
		t.Fatal(err)
	}
	input, err := NewPostgresSubmissionRepository(pool).LoadSubmissionInput(ctx, actor, claimID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewPostgresSubmissionRepository(pool).Submit(ctx, input, confirmation, "policy-stale-"+suffix, policy1, clock)
	if !errors.Is(err, application.ErrStaleSubmissionConfirmation) {
		t.Fatalf("expected transaction to reject stale policy, got %v", err)
	}
	result, err := service.ValidateClaim(ctx, actor, claimID)
	if err != nil || result.PolicyVersion != policy2 || len(result.Issues) != 1 || result.Issues[0].Code != "POLICY_TOTAL" {
		t.Fatalf("validation=%#v err=%v", result, err)
	}
	warningRules := rules(10000)
	warningRules[0].Severity = "WARNING"
	if err := publisher.Publish(actor, application.PolicyVersion{ID: policy3, EffectiveDate: "2026-10-03", Rules: warningRules}); err != nil {
		t.Fatal(err)
	}
	warningConfirmation, err := service.RequestSubmission(ctx, actor, claimID, 1)
	if err != nil || warningConfirmation.PolicyVersion != policy3 {
		t.Fatalf("warning confirmation=%#v err=%v", warningConfirmation, err)
	}
	snapshot, err := service.SubmitClaim(ctx, actor, claimID, warningConfirmation.Token, "policy-warning-"+suffix)
	if err != nil || snapshot.PolicyVersion != policy3 {
		t.Fatalf("snapshot=%#v err=%v", snapshot, err)
	}
	var recordedIssues int
	if err := pool.QueryRow(ctx, `SELECT jsonb_array_length(snapshot->'policyIssues') FROM reimbursement.submission_snapshots WHERE claim_id=$1`, claimID).Scan(&recordedIssues); err != nil || recordedIssues != 1 {
		t.Fatalf("recorded issues=%d err=%v", recordedIssues, err)
	}
	owned, err := NewPostgresClaimRepository(pool).FindOwned(ctx, claimID, actor)
	if err != nil || len(owned.SubmissionWarnings) != 1 || owned.SubmissionWarnings[0].Code != "POLICY_TOTAL" {
		t.Fatalf("submitted claim warnings=%#v err=%v", owned.SubmissionWarnings, err)
	}
}

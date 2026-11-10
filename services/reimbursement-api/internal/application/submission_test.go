package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestPublishedPolicyBlocksAndInvalidatesOldConfirmation(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(12000)
	repository.claim = domain.Claim{ID: "claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "客户拜访", RequestedAmountCent: &amount, Currency: domain.ClaimCurrencyCNY, Version: 1}
	repository.receipts = []domain.Receipt{{ID: "receipt-1", Status: domain.ReceiptStatusExtracted, OCRConfidence: 0.98}}
	service := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)})
	confirmation, err := service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	repository.activePolicy = &PolicyVersion{ID: "policy-2", EffectiveDate: "2026-10-01", Rules: []PolicyRule{{Code: "TOTAL", Name: "整单限额", Type: "CLAIM_TOTAL_MAX", Severity: "BLOCKING", Config: json.RawMessage(`{"maxAmountCents":10000}`)}}}
	result, err := service.ValidateClaim(context.Background(), "employee-1", "claim-1")
	if err != nil || result.PolicyVersion != "policy-2" || len(result.Issues) != 1 || result.Issues[0].Code != "POLICY_TOTAL" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if _, err := service.SubmitClaim(context.Background(), "employee-1", "claim-1", confirmation.Token, "submit-1"); !errors.Is(err, ErrStaleSubmissionConfirmation) {
		t.Fatalf("expected stale confirmation, got %v", err)
	}
	if _, err := service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1); !errors.Is(err, ErrValidationBlocked) {
		t.Fatalf("expected policy block, got %v", err)
	}
}

func TestValidateItemizedClaimChecksEachReceiptCategory(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(9000)
	repository.claim = domain.Claim{ID: "mixed", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, ItemizationMode: domain.ClaimItemizationModeItemized, Purpose: "市内出行及餐饮费用", RequestedAmountCent: &amount, Version: 3}
	repository.receipts = []domain.Receipt{{ID: "taxi", Status: domain.ReceiptStatusExtracted}, {ID: "dining", Status: domain.ReceiptStatusExtracted}}
	repository.items = []domain.ExpenseItem{{ID: "taxi", ReceiptID: "taxi", ExpenseCategory: "交通费", AmountCent: &amount}, {ID: "dining", ReceiptID: "dining", ExpenseCategory: "餐饮费", AmountCent: &amount}}
	repository.activePolicy = &PolicyVersion{ID: "mixed-policy", EffectiveDate: "2026-10-01", Rules: []PolicyRule{{Code: "PROJECT", Name: "餐饮项目", Type: "CATEGORY_REQUIRED_FIELD", Severity: "BLOCKING", Config: json.RawMessage(`{"category":"餐饮费","field":"projectCode"}`)}}}
	result, err := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)}).ValidateClaim(context.Background(), "employee-1", "mixed")
	if err != nil || len(result.Issues) != 1 || result.Issues[0].ReceiptID != "dining" {
		t.Fatalf("issues=%+v err=%v", result.Issues, err)
	}
}

func TestItemizedClaimRequiresEachReceiptAmountEvenWithManualClaimAmount(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(9000)
	repository.claim = domain.Claim{ID: "mixed", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, ItemizationMode: domain.ClaimItemizationModeItemized, Purpose: "市内出行", RequestedAmountCent: &amount, Version: 3}
	repository.receipts = []domain.Receipt{{ID: "taxi", Status: domain.ReceiptStatusExtracted}}
	repository.items = []domain.ExpenseItem{{ID: "taxi", ReceiptID: "taxi"}}
	service := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)})
	validation, err := service.ValidateClaim(context.Background(), "employee-1", "mixed")
	if err != nil || len(validation.Issues) != 1 || validation.Issues[0].Code != "EXPENSE_ITEM_AMOUNT_REQUIRED" || validation.Issues[0].ReceiptID != "taxi" {
		t.Fatalf("issues=%+v err=%v", validation.Issues, err)
	}
	if _, err := service.RequestSubmission(context.Background(), "employee-1", "mixed", 3); !errors.Is(err, ErrValidationBlocked) {
		t.Fatalf("missing item amount should block confirmation: %v", err)
	}
}

func TestRequestSubmissionReturnsNonBlockingPolicyWarnings(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(12000)
	repository.claim = domain.Claim{ID: "claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "客户拜访", RequestedAmountCent: &amount, Currency: domain.ClaimCurrencyCNY, Version: 1}
	repository.receipts = []domain.Receipt{{ID: "receipt-1", Status: domain.ReceiptStatusExtracted, OCRConfidence: 0.98}}
	repository.activePolicy = &PolicyVersion{ID: "warning-policy", EffectiveDate: "2026-10-29", Rules: []PolicyRule{{Code: "TOTAL", Name: "整单上限", Type: "CLAIM_TOTAL_MAX", Severity: "WARNING", Config: json.RawMessage(`{"maxAmountCents":10000}`)}}}
	service := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 10, 29, 9, 0, 0, 0, time.UTC)})
	confirmation, err := service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1)
	if err != nil || len(confirmation.Warnings) != 1 || confirmation.Warnings[0].Code != "POLICY_TOTAL" || confirmation.Warnings[0].Blocking {
		t.Fatalf("confirmation=%#v err=%v", confirmation, err)
	}
}

func TestSubmitClaimRevalidatesBeforeSubmit(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(10155)
	repository.claim = domain.Claim{ID: "claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "客户拜访", RequestedAmountCent: &amount, Currency: domain.ClaimCurrencyCNY, Version: 1}
	repository.receipts = []domain.Receipt{{ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", Status: domain.ReceiptStatusExtracted, OCRConfidence: 0.98}}
	service := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)})

	confirmation, err := service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1)
	if err != nil {
		t.Fatalf("request confirmation: %v", err)
	}
	repository.receipts = nil

	_, err = service.SubmitClaim(context.Background(), "employee-1", "claim-1", confirmation.Token, "submit-key-1")
	if !errors.Is(err, ErrValidationBlocked) {
		t.Fatalf("expected ErrValidationBlocked, got %v", err)
	}
}

func TestRequestSubmissionRequiresRequestedAmount(t *testing.T) {
	repository := newFakeSubmissionRepository()
	repository.claim = domain.Claim{ID: "claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "客户拜访", Currency: domain.ClaimCurrencyCNY, RequestedAmountSource: domain.RequestedAmountSourceSuggested, Version: 1}
	repository.receipts = []domain.Receipt{{ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", Status: domain.ReceiptStatusExtracted, OCRConfidence: 0.98}}
	service := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 10, 8, 9, 0, 0, 0, time.UTC)})

	validation, err := service.ValidateClaim(context.Background(), "employee-1", "claim-1")
	if err != nil {
		t.Fatalf("validate claim: %v", err)
	}
	if len(validation.Issues) != 1 || validation.Issues[0].Code != "REQUESTED_AMOUNT_REQUIRED" || !validation.Issues[0].Blocking {
		t.Fatalf("validation issues = %#v", validation.Issues)
	}
	if _, err = service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1); !errors.Is(err, ErrValidationBlocked) {
		t.Fatalf("request submission error = %v, want ErrValidationBlocked", err)
	}
}

func TestSubmitClaimRejectsStaleConfirmation(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(10155)
	repository.claim = domain.Claim{ID: "claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "客户拜访", RequestedAmountCent: &amount, Currency: domain.ClaimCurrencyCNY, Version: 1}
	repository.receipts = []domain.Receipt{{ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", Status: domain.ReceiptStatusExtracted, OCRConfidence: 0.98}}
	clock := fixedClock{now: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)}
	service := NewSubmissionService(repository, clock)
	confirmation, err := service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1)
	if err != nil {
		t.Fatalf("request confirmation: %v", err)
	}
	repository.claim.Version = 2

	_, err = service.SubmitClaim(context.Background(), "employee-1", "claim-1", confirmation.Token, "submit-key-1")
	if !errors.Is(err, ErrStaleSubmissionConfirmation) {
		t.Fatalf("expected ErrStaleSubmissionConfirmation, got %v", err)
	}
}

func TestSubmitClaimReplaysIdempotentSubmission(t *testing.T) {
	repository := newFakeSubmissionRepository()
	amount := int64(10155)
	repository.claim = domain.Claim{ID: "claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "客户拜访", RequestedAmountCent: &amount, Currency: domain.ClaimCurrencyCNY, Version: 1}
	repository.receipts = []domain.Receipt{{ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", Status: domain.ReceiptStatusExtracted, OCRConfidence: 0.98}}
	service := NewSubmissionService(repository, fixedClock{now: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)})
	confirmation, err := service.RequestSubmission(context.Background(), "employee-1", "claim-1", 1)
	if err != nil {
		t.Fatalf("request confirmation: %v", err)
	}

	first, err := service.SubmitClaim(context.Background(), "employee-1", "claim-1", confirmation.Token, "submit-key-1")
	if err != nil {
		t.Fatalf("submit claim: %v", err)
	}
	second, err := service.SubmitClaim(context.Background(), "employee-1", "claim-1", confirmation.Token, "submit-key-1")
	if err != nil {
		t.Fatalf("replay submit claim: %v", err)
	}
	if first.SubmissionNumber != second.SubmissionNumber || repository.submitCalls != 1 {
		t.Fatalf("expected one submission replay, first=%#v second=%#v calls=%d", first, second, repository.submitCalls)
	}
}

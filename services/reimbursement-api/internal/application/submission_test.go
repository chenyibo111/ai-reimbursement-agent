package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

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

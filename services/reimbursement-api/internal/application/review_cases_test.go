package application

import (
	"context"
	"errors"
	"testing"
)

func TestReviewCase_EmployeeCannotReadOrClaimReceiptReview(t *testing.T) {
	service := NewReviewCaseService(NewMemoryReviewCaseRepository(receiptReviewCase("review-1", ReviewCaseOpen, "", 1)))

	if _, err := service.ListReceiptCases(context.Background(), "EMPLOYEE"); !errors.Is(err, ErrReviewCaseForbidden) {
		t.Fatalf("list error = %v, want forbidden", err)
	}
	if _, err := service.ClaimReceiptCase(context.Background(), "employee-1", "EMPLOYEE", ClaimReviewCaseCommand{CaseID: "review-1", ExpectedVersion: 1}); !errors.Is(err, ErrReviewCaseForbidden) {
		t.Fatalf("claim error = %v, want forbidden", err)
	}
}

func TestReviewCase_OnlyOneReviewerCanClaimExpectedVersion(t *testing.T) {
	service := NewReviewCaseService(NewMemoryReviewCaseRepository(receiptReviewCase("review-1", ReviewCaseOpen, "", 3)))

	claimed, err := service.ClaimReceiptCase(context.Background(), "finance-1", "FINANCE_REVIEWER", ClaimReviewCaseCommand{CaseID: "review-1", ExpectedVersion: 3})
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if claimed.AssignedTo != "finance-1" || claimed.Status != ReviewCaseClaimed || claimed.Version != 4 {
		t.Fatalf("claimed case = %#v", claimed)
	}
	if _, err := service.ClaimReceiptCase(context.Background(), "finance-2", "FINANCE_REVIEWER", ClaimReviewCaseCommand{CaseID: "review-1", ExpectedVersion: 3}); !errors.Is(err, ErrReviewCaseConflict) {
		t.Fatalf("second same-version claim error = %v, want conflict", err)
	}
}

func TestReviewCase_OnlyClaimantCanResolveButAdministratorCanTakeOver(t *testing.T) {
	service := NewReviewCaseService(NewMemoryReviewCaseRepository(receiptReviewCase("review-1", ReviewCaseClaimed, "finance-1", 4)))

	command := ResolveReceiptCaseCommand{CaseID: "review-1", ExpectedVersion: 4, Resolution: "确认票据字段"}
	if _, err := service.ResolveReceiptCase(context.Background(), "finance-2", "FINANCE_REVIEWER", command); !errors.Is(err, ErrReviewCaseForbidden) {
		t.Fatalf("non-claimant resolve error = %v, want forbidden", err)
	}
	resolved, err := service.ResolveReceiptCase(context.Background(), "admin-1", "ADMIN", command)
	if err != nil {
		t.Fatalf("administrator takeover: %v", err)
	}
	if resolved.Status != ReviewCaseResolved || resolved.ResolvedBy != "admin-1" || resolved.Version != 5 {
		t.Fatalf("resolved case = %#v", resolved)
	}
}

func TestReviewCase_ResolutionRequiresExpectedVersion(t *testing.T) {
	service := NewReviewCaseService(NewMemoryReviewCaseRepository(receiptReviewCase("review-1", ReviewCaseClaimed, "finance-1", 4)))

	_, err := service.ResolveReceiptCase(context.Background(), "finance-1", "FINANCE_REVIEWER", ResolveReceiptCaseCommand{CaseID: "review-1", ExpectedVersion: 3, Resolution: "确认票据字段"})
	if !errors.Is(err, ErrReviewCaseConflict) {
		t.Fatalf("resolve with stale version error = %v, want conflict", err)
	}
}

func receiptReviewCase(id string, status ReviewCaseStatus, assignedTo string, version int64) ReviewCase {
	return ReviewCase{
		ID:         id,
		ClaimID:    "claim-1",
		ReceiptID:  "receipt-1",
		Kind:       "RECEIPT_OCR",
		ReasonCode: "OCR_LOW_CONFIDENCE",
		Status:     status,
		AssignedTo: assignedTo,
		Version:    version,
	}
}

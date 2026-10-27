package application

import (
	"context"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type progressRepositoryFixture struct{ progress ClaimProgress }

func (fixture progressRepositoryFixture) LoadOwnedProgress(context.Context, string, string) (ClaimProgress, error) {
	return fixture.progress, nil
}

type progressValidatorFixture struct{ calls int }

func (fixture *progressValidatorFixture) ValidateClaim(context.Context, string, string) (ValidationResult, error) {
	fixture.calls++
	return ValidationResult{Issues: []domain.ValidationIssue{{Code: "PURPOSE_REQUIRED", Message: "报销事由不能为空", Blocking: true}}}, nil
}

func TestClaimProgressAddsCurrentValidationOnlyForDraft(t *testing.T) {
	validator := &progressValidatorFixture{}
	service := NewClaimProgressService(progressRepositoryFixture{ClaimProgress{ClaimID: "claim-1", Status: "DRAFT"}}, validator)
	progress, err := service.GetClaimProgress(context.Background(), "employee-1", "claim-1")
	if err != nil || validator.calls != 1 || len(progress.Issues) != 1 || progress.Issues[0].Severity != "BLOCKING" || progress.Approval != "NOT_CONNECTED" || progress.Payment != "NOT_CONNECTED" {
		t.Fatalf("draft=%#v calls=%d err=%v", progress, validator.calls, err)
	}
	service = NewClaimProgressService(progressRepositoryFixture{ClaimProgress{ClaimID: "claim-1", Status: "SUBMITTED"}}, validator)
	progress, err = service.GetClaimProgress(context.Background(), "employee-1", "claim-1")
	if err != nil || validator.calls != 1 || len(progress.Issues) != 0 {
		t.Fatalf("submitted=%#v calls=%d err=%v", progress, validator.calls, err)
	}
}

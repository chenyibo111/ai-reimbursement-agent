package application

import (
	"context"
	"errors"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestCreateClaimAssignsDraftToActor(t *testing.T) {
	service := NewClaimService(NewMemoryClaimRepository(), NewSequentialIDGenerator())

	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	if claim.OwnerID != "employee-1" || claim.Status != domain.ClaimStatusDraft || claim.Version != 1 {
		t.Fatalf("unexpected claim view: %#v", claim)
	}
}

func TestUpdateClaimRejectsAnotherEmployeesClaim(t *testing.T) {
	service := NewClaimService(NewMemoryClaimRepository(), NewSequentialIDGenerator())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}

	_, err = service.UpdateClaim(context.Background(), "employee-2", claim.ID, claim.Version, PatchClaimCommand{Purpose: stringPointer("其他用途")})
	if !errors.Is(err, ErrClaimNotFound) {
		t.Fatalf("expected ErrClaimNotFound, got %v", err)
	}
}

func TestUpdateClaimRejectsStaleVersion(t *testing.T) {
	service := NewClaimService(NewMemoryClaimRepository(), NewSequentialIDGenerator())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	updated, err := service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{Purpose: stringPointer("客户交流")})
	if err != nil {
		t.Fatalf("update claim: %v", err)
	}

	_, err = service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{Purpose: stringPointer("过期更新")})
	if !errors.Is(err, ErrClaimVersionConflict) {
		t.Fatalf("expected ErrClaimVersionConflict, got %v", err)
	}
	if updated.Version != 2 {
		t.Fatalf("expected version 2, got %d", updated.Version)
	}
}

func TestUpdateClaimRejectsSubmittedClaim(t *testing.T) {
	repository := NewMemoryClaimRepository()
	service := NewClaimService(repository, NewSequentialIDGenerator())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	if err := repository.SetStatusForTest(claim.ID, domain.ClaimStatusSubmitted); err != nil {
		t.Fatalf("submit test claim: %v", err)
	}

	_, err = service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{Purpose: stringPointer("不能修改")})
	if !errors.Is(err, domain.ErrClaimNotDraft) {
		t.Fatalf("expected ErrClaimNotDraft, got %v", err)
	}
}

func TestUpdateClaimRejectsUnknownFields(t *testing.T) {
	service := NewClaimService(NewMemoryClaimRepository(), NewSequentialIDGenerator())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}

	_, err = service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{UnknownFields: []string{"approvedAmount"}})
	if !errors.Is(err, ErrValidationBlocked) {
		t.Fatalf("expected ErrValidationBlocked, got %v", err)
	}
}

func TestDeleteClaimAllowsOnlyOwnDraftAtCurrentVersion(t *testing.T) {
	service := NewClaimService(NewMemoryClaimRepository(), NewSequentialIDGenerator())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}

	if err := service.DeleteClaim(context.Background(), "employee-1", claim.ID, claim.Version); err != nil {
		t.Fatalf("delete draft: %v", err)
	}
	_, err = service.GetClaim(context.Background(), "employee-1", claim.ID)
	if !errors.Is(err, ErrClaimNotFound) {
		t.Fatalf("expected deleted claim to be hidden, got %v", err)
	}
}

func stringPointer(value string) *string { return &value }

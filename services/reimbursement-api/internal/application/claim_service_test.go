package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestCreateClaimAssignsImmutableBusinessNumber(t *testing.T) {
	service := NewClaimService(
		NewMemoryClaimRepository(),
		NewSequentialIDGenerator(),
		NewMemoryClaimNumberGenerator(),
		func() time.Time { return time.Date(2026, 10, 8, 1, 0, 0, 0, time.UTC) },
	)

	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	if claim.ClaimNumber != "BX20261008-0001" {
		t.Fatalf("claim number = %q, want BX20261008-0001", claim.ClaimNumber)
	}

	updated, err := service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{Purpose: stringPointer("客户交流")})
	if err != nil {
		t.Fatalf("update claim: %v", err)
	}
	if updated.ClaimNumber != claim.ClaimNumber {
		t.Fatalf("claim number changed from %q to %q", claim.ClaimNumber, updated.ClaimNumber)
	}
}

func TestCreateClaimAssignsDraftToActor(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())

	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	if claim.OwnerID != "employee-1" || claim.Status != domain.ClaimStatusDraft || claim.Version != 1 {
		t.Fatalf("unexpected claim view: %#v", claim)
	}
}

func TestCreateClaimAllowsAnIncompleteDraft(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())

	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{})
	if err != nil {
		t.Fatalf("create incomplete draft: %v", err)
	}
	if claim.Purpose != "" || claim.Status != domain.ClaimStatusDraft {
		t.Fatalf("incomplete draft = %#v", claim)
	}
}

func TestUpdateClaimRejectsAnotherEmployeesClaim(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
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
	service := newClaimServiceForTest(NewMemoryClaimRepository())
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
	service := newClaimServiceForTest(repository)
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
	service := newClaimServiceForTest(NewMemoryClaimRepository())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}

	_, err = service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{UnknownFields: []string{"approvedAmount"}})
	if !errors.Is(err, ErrValidationBlocked) {
		t.Fatalf("expected ErrValidationBlocked, got %v", err)
	}
}

func TestUpdateClaimStoresManualRequestedAmount(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	amount := int64(10155)
	currency := "CNY"
	remark := "客户拜访交通费"
	updated, err := service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{
		RequestedAmountCent: &amount,
		Currency:            &currency,
		Remark:              &remark,
	})
	if err != nil {
		t.Fatalf("update claim: %v", err)
	}
	if updated.RequestedAmountCent == nil || *updated.RequestedAmountCent != 10155 || updated.Currency != "CNY" || updated.Remark != remark {
		t.Fatalf("updated application fields = %#v", updated)
	}
}

func TestUpdateClaimRestoreReturnsCurrentOCRSuggestion(t *testing.T) {
	repository := NewMemoryClaimRepository()
	service := NewClaimService(repository, NewSequentialIDGenerator(), NewMemoryClaimNumberGenerator(), time.Now, memoryOCRSuggestionRefresher{repository: repository, amount: 12155})
	claim, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{Purpose: "客户拜访"})
	if err != nil {
		t.Fatalf("create claim: %v", err)
	}
	manualAmount := int64(9999)
	manual, err := service.UpdateClaim(context.Background(), "employee-1", claim.ID, claim.Version, PatchClaimCommand{RequestedAmountCent: &manualAmount})
	if err != nil {
		t.Fatalf("set manual amount: %v", err)
	}

	restored, err := service.UpdateClaim(context.Background(), "employee-1", claim.ID, manual.Version, PatchClaimCommand{UseOCRSuggestedAmount: true})
	if err != nil {
		t.Fatalf("restore OCR suggestion: %v", err)
	}
	if restored.RequestedAmountCent == nil || *restored.RequestedAmountCent != 12155 || restored.RequestedAmountSource != domain.RequestedAmountSourceSuggested {
		t.Fatalf("restored claim = %#v", restored)
	}
}

func TestDeleteClaimAllowsOnlyOwnDraftAtCurrentVersion(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
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

func newClaimServiceForTest(repository ClaimRepository) *ClaimService {
	return NewClaimService(repository, NewSequentialIDGenerator(), NewMemoryClaimNumberGenerator(), time.Now)
}

type memoryOCRSuggestionRefresher struct {
	repository *MemoryClaimRepository
	amount     int64
}

func (refresher memoryOCRSuggestionRefresher) RefreshOCRSuggestion(_ context.Context, claimID string, actorID string) error {
	refresher.repository.mu.Lock()
	defer refresher.repository.mu.Unlock()
	claim, found := refresher.repository.claims[claimID]
	if !found || claim.OwnerID != actorID || claim.RequestedAmountSource != domain.RequestedAmountSourceSuggested {
		return ErrClaimNotFound
	}
	amount := refresher.amount
	claim.RequestedAmountCent = &amount
	claim.Version++
	refresher.repository.claims[claimID] = claim
	return nil
}

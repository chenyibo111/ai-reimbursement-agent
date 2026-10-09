package domain

import (
	"errors"
	"testing"
)

func TestNewDraftClaimAssignsOwnerAndVersion(t *testing.T) {
	claim, err := NewDraftClaim("claim-1", "BX20261008-0001", "employee-1", "差旅报销")
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}

	if claim.OwnerID != "employee-1" || claim.Status != ClaimStatusDraft || claim.Version != 1 {
		t.Fatalf("unexpected initial claim: %#v", claim)
	}
}

func TestClaimPatchRejectsSubmittedClaim(t *testing.T) {
	claim, err := NewDraftClaim("claim-1", "BX20261008-0001", "employee-1", "差旅报销")
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	claim.Status = ClaimStatusSubmitted

	err = claim.Patch(1, ClaimPatch{Purpose: stringPointer("更新用途")})
	if !errors.Is(err, ErrClaimNotDraft) {
		t.Fatalf("expected ErrClaimNotDraft, got %v", err)
	}
}

func TestClaimPatchStoresManualRequestedAmountCurrencyAndRemark(t *testing.T) {
	claim, err := NewDraftClaim("claim-1", "BX20261008-0001", "employee-1", "差旅报销")
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	amount := int64(10155)
	currency := "CNY"
	remark := "客户拜访交通费"
	if err = claim.Patch(1, ClaimPatch{RequestedAmountCent: &amount, Currency: &currency, Remark: &remark}); err != nil {
		t.Fatalf("patch claim: %v", err)
	}
	if claim.RequestedAmountCent == nil || *claim.RequestedAmountCent != 10155 {
		t.Fatalf("requested amount = %#v, want 10155", claim.RequestedAmountCent)
	}
	if claim.Currency != "CNY" || claim.RequestedAmountSource != RequestedAmountSourceManual || claim.Remark != remark {
		t.Fatalf("claim application fields = %#v", claim)
	}
}

func TestClaimDeleteRejectsStaleVersion(t *testing.T) {
	claim, err := NewDraftClaim("claim-1", "BX20261008-0001", "employee-1", "差旅报销")
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}

	err = claim.CanDelete(2)
	if !errors.Is(err, ErrClaimVersionConflict) {
		t.Fatalf("expected ErrClaimVersionConflict, got %v", err)
	}
}

func stringPointer(value string) *string { return &value }

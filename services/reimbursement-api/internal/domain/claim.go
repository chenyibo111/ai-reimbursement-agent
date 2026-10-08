package domain

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrClaimNotDraft        = errors.New("claim is not a draft")
	ErrClaimVersionConflict = errors.New("claim version conflict")
	ErrInvalidClaim         = errors.New("invalid claim")
)

type ClaimStatus string

type RequestedAmountSource string

const (
	ClaimStatusDraft               ClaimStatus           = "DRAFT"
	ClaimStatusSubmitted           ClaimStatus           = "SUBMITTED"
	RequestedAmountSourceSuggested RequestedAmountSource = "OCR_SUGGESTED"
	RequestedAmountSourceManual    RequestedAmountSource = "MANUAL"
	ClaimCurrencyCNY                                     = "CNY"
	MaxClaimRemarkRunes                                  = 1000
)

type Claim struct {
	ID                        string
	ClaimNumber               string
	OwnerID                   string
	Status                    ClaimStatus
	Purpose                   string
	ExpenseCategory           string
	Participants              []string
	ProjectCode               string
	Version                   int64
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
	ReceiptCount              int
	RecognizedReceiptCount    int
	TotalAmountCent           *int64
	MissingAmountReceiptCount int
	RequestedAmountCent       *int64
	Currency                  string
	RequestedAmountSource     RequestedAmountSource
	Remark                    string
}

type ClaimPatch struct {
	Purpose               *string
	ExpenseCategory       *string
	Participants          *[]string
	ProjectCode           *string
	RequestedAmountCent   *int64
	Currency              *string
	Remark                *string
	UseOCRSuggestedAmount bool
}

func NewDraftClaim(id string, claimNumber string, ownerID string, purpose string) (Claim, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(claimNumber) == "" || strings.TrimSpace(ownerID) == "" || strings.TrimSpace(purpose) == "" {
		return Claim{}, ErrInvalidClaim
	}
	now := time.Now().UTC()
	return Claim{
		ID:                    id,
		ClaimNumber:           claimNumber,
		OwnerID:               ownerID,
		Status:                ClaimStatusDraft,
		Purpose:               purpose,
		Currency:              ClaimCurrencyCNY,
		RequestedAmountSource: RequestedAmountSourceSuggested,
		Version:               1,
		CreatedAt:             now,
		UpdatedAt:             now,
	}, nil
}

func (claim *Claim) Patch(expectedVersion int64, patch ClaimPatch) error {
	if claim.Status != ClaimStatusDraft {
		return ErrClaimNotDraft
	}
	if claim.Version != expectedVersion {
		return ErrClaimVersionConflict
	}
	if patch.Purpose != nil {
		if strings.TrimSpace(*patch.Purpose) == "" {
			return ErrInvalidClaim
		}
		claim.Purpose = *patch.Purpose
	}
	if patch.ExpenseCategory != nil {
		claim.ExpenseCategory = *patch.ExpenseCategory
	}
	if patch.Participants != nil {
		claim.Participants = append([]string(nil), (*patch.Participants)...)
	}
	if patch.ProjectCode != nil {
		claim.ProjectCode = *patch.ProjectCode
	}
	if patch.Currency != nil {
		if *patch.Currency != ClaimCurrencyCNY {
			return ErrInvalidClaim
		}
		claim.Currency = *patch.Currency
	}
	if patch.Remark != nil {
		if utf8.RuneCountInString(*patch.Remark) > MaxClaimRemarkRunes {
			return ErrInvalidClaim
		}
		claim.Remark = *patch.Remark
	}
	if patch.UseOCRSuggestedAmount && patch.RequestedAmountCent != nil {
		return ErrInvalidClaim
	}
	if patch.UseOCRSuggestedAmount {
		claim.RequestedAmountCent = nil
		claim.RequestedAmountSource = RequestedAmountSourceSuggested
	}
	if patch.RequestedAmountCent != nil {
		if *patch.RequestedAmountCent < 0 {
			return ErrInvalidClaim
		}
		amount := *patch.RequestedAmountCent
		claim.RequestedAmountCent = &amount
		claim.RequestedAmountSource = RequestedAmountSourceManual
	}
	claim.Version++
	claim.UpdatedAt = time.Now().UTC()
	return nil
}

func (claim Claim) CanDelete(expectedVersion int64) error {
	if claim.Status != ClaimStatusDraft {
		return ErrClaimNotDraft
	}
	if claim.Version != expectedVersion {
		return ErrClaimVersionConflict
	}
	return nil
}

func (claim Claim) Clone() Claim {
	claim.Participants = append([]string(nil), claim.Participants...)
	if claim.TotalAmountCent != nil {
		total := *claim.TotalAmountCent
		claim.TotalAmountCent = &total
	}
	if claim.RequestedAmountCent != nil {
		amount := *claim.RequestedAmountCent
		claim.RequestedAmountCent = &amount
	}
	return claim
}

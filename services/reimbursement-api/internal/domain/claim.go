package domain

import (
	"errors"
	"strings"
	"time"
)

var (
	ErrClaimNotDraft        = errors.New("claim is not a draft")
	ErrClaimVersionConflict = errors.New("claim version conflict")
	ErrInvalidClaim         = errors.New("invalid claim")
)

type ClaimStatus string

const (
	ClaimStatusDraft     ClaimStatus = "DRAFT"
	ClaimStatusSubmitted ClaimStatus = "SUBMITTED"
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
}

type ClaimPatch struct {
	Purpose         *string
	ExpenseCategory *string
	Participants    *[]string
	ProjectCode     *string
}

func NewDraftClaim(id string, claimNumber string, ownerID string, purpose string) (Claim, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(claimNumber) == "" || strings.TrimSpace(ownerID) == "" || strings.TrimSpace(purpose) == "" {
		return Claim{}, ErrInvalidClaim
	}
	now := time.Now().UTC()
	return Claim{
		ID:          id,
		ClaimNumber: claimNumber,
		OwnerID:     ownerID,
		Status:      ClaimStatusDraft,
		Purpose:     purpose,
		Version:     1,
		CreatedAt:   now,
		UpdatedAt:   now,
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
	return claim
}

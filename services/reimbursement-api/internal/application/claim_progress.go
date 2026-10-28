package application

import (
	"context"
	"fmt"
)

// ClaimProgress contains only facts an employee may see about their own claim.
// Approval and payment are explicit extension slots until those systems exist.
type ClaimProgress struct {
	ClaimID          string            `json:"claimId"`
	ClaimNumber      string            `json:"claimNumber"`
	Status           string            `json:"status"`
	Version          int64             `json:"version"`
	SubmissionNumber *string           `json:"submissionNumber"`
	SubmittedAt      *string           `json:"submittedAt"`
	Receipts         []ReceiptProgress `json:"receipts"`
	Issues           []ProgressIssue   `json:"issues"`
	Approval         string            `json:"approval"`
	Payment          string            `json:"payment"`
}

type ReceiptProgress struct {
	ReceiptID    string `json:"receiptId"`
	Filename     string `json:"filename"`
	Status       string `json:"status"`
	ReviewStatus string `json:"reviewStatus"`
}

type ProgressIssue struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Severity string `json:"severity"`
}

type ClaimProgressRepository interface {
	LoadOwnedProgress(context.Context, string, string) (ClaimProgress, error)
}

type ClaimProgressValidator interface {
	ValidateClaim(context.Context, string, string) (ValidationResult, error)
}

type ClaimProgressService struct {
	repository ClaimProgressRepository
	validator  ClaimProgressValidator
}

func NewClaimProgressService(repository ClaimProgressRepository, validator ClaimProgressValidator) *ClaimProgressService {
	return &ClaimProgressService{repository: repository, validator: validator}
}

func (service *ClaimProgressService) GetClaimProgress(ctx context.Context, actorID, claimID string) (ClaimProgress, error) {
	progress, err := service.repository.LoadOwnedProgress(ctx, actorID, claimID)
	if err != nil {
		return ClaimProgress{}, err
	}
	progress.Approval, progress.Payment = "NOT_CONNECTED", "NOT_CONNECTED"
	if progress.Receipts == nil {
		progress.Receipts = []ReceiptProgress{}
	}
	progress.Issues = []ProgressIssue{}
	if progress.Status == "DRAFT" {
		validation, err := service.validator.ValidateClaim(ctx, actorID, claimID)
		if err != nil {
			return ClaimProgress{}, fmt.Errorf("validate claim progress: %w", err)
		}
		for _, issue := range validation.Issues {
			severity := "WARNING"
			if issue.Blocking {
				severity = "BLOCKING"
			}
			progress.Issues = append(progress.Issues, ProgressIssue{Code: issue.Code, Message: issue.Message, Severity: severity})
		}
	}
	return progress, nil
}

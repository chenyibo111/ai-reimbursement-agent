package application

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

var (
	ErrStaleSubmissionConfirmation   = errors.New("submission confirmation is stale")
	ErrSubmissionConfirmationExpired = errors.New("submission confirmation expired")
)

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

type SubmissionConfirmation struct {
	Token         string
	ClaimID       string
	ActorID       string
	ClaimVersion  int64
	PolicyVersion string
	ExpiresAt     time.Time
}

type SubmissionSnapshot struct {
	ClaimID          string
	SubmissionNumber string
	ClaimVersion     int64
	PolicyVersion    string
	SubmittedAt      time.Time
}

type ValidationResult struct {
	ClaimID       string
	ClaimVersion  int64
	PolicyVersion string
	Issues        []domain.ValidationIssue
}

type SubmissionInput struct {
	Claim    domain.Claim
	Receipts []domain.Receipt
}

type SubmissionRepository interface {
	LoadSubmissionInput(context.Context, string, string) (SubmissionInput, error)
	StoreConfirmation(context.Context, SubmissionConfirmation) error
	FindConfirmation(context.Context, string) (SubmissionConfirmation, error)
	FindSubmissionByIdempotencyKey(context.Context, string, string, string) (SubmissionSnapshot, error)
	Submit(context.Context, SubmissionInput, SubmissionConfirmation, string, string) (SubmissionSnapshot, error)
}

type SubmissionService struct {
	repository SubmissionRepository
	clock      Clock
}

func NewSubmissionService(repository SubmissionRepository, clock Clock) *SubmissionService {
	if clock == nil {
		clock = systemClock{}
	}
	return &SubmissionService{repository: repository, clock: clock}
}

func (service *SubmissionService) ValidateClaim(ctx context.Context, actorID string, claimID string) (ValidationResult, error) {
	input, err := service.repository.LoadSubmissionInput(ctx, actorID, claimID)
	if errors.Is(err, ErrClaimNotFound) {
		return ValidationResult{}, ErrClaimNotFound
	}
	if err != nil {
		return ValidationResult{}, fmt.Errorf("load claim validation input: %w", err)
	}
	issues := validateSubmissionInput(input)
	return ValidationResult{ClaimID: input.Claim.ID, ClaimVersion: input.Claim.Version, PolicyVersion: "baseline-v1", Issues: issues}, nil
}

func (service *SubmissionService) RequestSubmission(ctx context.Context, actorID string, claimID string, expectedVersion int64) (SubmissionConfirmation, error) {
	validation, err := service.ValidateClaim(ctx, actorID, claimID)
	if err != nil {
		return SubmissionConfirmation{}, err
	}
	if validation.ClaimVersion != expectedVersion {
		return SubmissionConfirmation{}, ErrStaleSubmissionConfirmation
	}
	if hasBlockingIssue(validation.Issues) {
		return SubmissionConfirmation{}, ErrValidationBlocked
	}
	confirmation := SubmissionConfirmation{Token: randomToken(), ClaimID: claimID, ActorID: actorID, ClaimVersion: validation.ClaimVersion, PolicyVersion: validation.PolicyVersion, ExpiresAt: service.clock.Now().Add(15 * time.Minute)}
	if err = service.repository.StoreConfirmation(ctx, confirmation); err != nil {
		return SubmissionConfirmation{}, fmt.Errorf("store submission confirmation: %w", err)
	}
	return confirmation, nil
}

func (service *SubmissionService) SubmitClaim(ctx context.Context, actorID string, claimID string, confirmationToken string, idempotencyKey string) (SubmissionSnapshot, error) {
	if strings.TrimSpace(idempotencyKey) == "" {
		return SubmissionSnapshot{}, ErrValidationBlocked
	}
	if replay, err := service.repository.FindSubmissionByIdempotencyKey(ctx, actorID, claimID, idempotencyKey); err == nil {
		return replay, nil
	} else if !errors.Is(err, ErrClaimNotFound) {
		return SubmissionSnapshot{}, fmt.Errorf("find submission replay: %w", err)
	}
	confirmation, err := service.repository.FindConfirmation(ctx, confirmationToken)
	if errors.Is(err, ErrClaimNotFound) {
		return SubmissionSnapshot{}, ErrStaleSubmissionConfirmation
	}
	if err != nil {
		return SubmissionSnapshot{}, fmt.Errorf("find submission confirmation: %w", err)
	}
	if confirmation.ActorID != actorID || confirmation.ClaimID != claimID {
		return SubmissionSnapshot{}, ErrStaleSubmissionConfirmation
	}
	if !confirmation.ExpiresAt.After(service.clock.Now()) {
		return SubmissionSnapshot{}, ErrSubmissionConfirmationExpired
	}
	validation, err := service.ValidateClaim(ctx, actorID, claimID)
	if err != nil {
		return SubmissionSnapshot{}, err
	}
	if validation.ClaimVersion != confirmation.ClaimVersion || validation.PolicyVersion != confirmation.PolicyVersion {
		return SubmissionSnapshot{}, ErrStaleSubmissionConfirmation
	}
	if hasBlockingIssue(validation.Issues) {
		return SubmissionSnapshot{}, ErrValidationBlocked
	}
	input, err := service.repository.LoadSubmissionInput(ctx, actorID, claimID)
	if err != nil {
		return SubmissionSnapshot{}, fmt.Errorf("reload submission input: %w", err)
	}
	snapshot, err := service.repository.Submit(ctx, input, confirmation, idempotencyKey, validation.PolicyVersion)
	if err != nil {
		return SubmissionSnapshot{}, fmt.Errorf("persist submission: %w", err)
	}
	return snapshot, nil
}

func validateSubmissionInput(input SubmissionInput) []domain.ValidationIssue {
	issues := make([]domain.ValidationIssue, 0)
	if input.Claim.Status != domain.ClaimStatusDraft {
		issues = append(issues, domain.ValidationIssue{Code: "CLAIM_NOT_DRAFT", Message: "报销单不是草稿状态", Blocking: true})
	}
	if strings.TrimSpace(input.Claim.Purpose) == "" {
		issues = append(issues, domain.ValidationIssue{Code: "PURPOSE_REQUIRED", Message: "报销事由不能为空", Blocking: true})
	}
	if len(input.Receipts) == 0 {
		issues = append(issues, domain.ValidationIssue{Code: "RECEIPT_REQUIRED", Message: "至少需要一张票据", Blocking: true})
	}
	for _, receipt := range input.Receipts {
		if receipt.Status == domain.ReceiptStatusReview || receipt.Status == domain.ReceiptStatusQuarantined {
			issues = append(issues, domain.ValidationIssue{Code: "RECEIPT_REVIEW_REQUIRED", Message: "存在需要人工复核的票据", Blocking: true})
		}
		if receipt.Status != domain.ReceiptStatusExtracted {
			issues = append(issues, domain.ValidationIssue{Code: "RECEIPT_NOT_EXTRACTED", Message: "票据尚未完成识别", Blocking: true})
		}
		if receipt.OCRConfidence > 0 && receipt.OCRConfidence < 0.7 {
			issues = append(issues, domain.ValidationIssue{Code: "LOW_OCR_CONFIDENCE", Message: "票据识别置信度过低", Blocking: true})
		}
	}
	return issues
}

func hasBlockingIssue(issues []domain.ValidationIssue) bool {
	for _, issue := range issues {
		if issue.IsBlocking() {
			return true
		}
	}
	return false
}

func randomToken() string {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("confirmation-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes)
}

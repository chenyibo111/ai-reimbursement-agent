package application

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrReviewCaseForbidden = errors.New("review case access is forbidden")
	ErrReviewCaseNotFound  = errors.New("review case not found")
	ErrReviewCaseConflict  = errors.New("review case version or state conflict")
	ErrInvalidReviewCase   = errors.New("invalid review case command")
)

type ReviewCaseStatus string

const (
	ReviewCaseOpen     ReviewCaseStatus = "OPEN"
	ReviewCaseClaimed  ReviewCaseStatus = "CLAIMED"
	ReviewCaseResolved ReviewCaseStatus = "RESOLVED"
	ReviewCaseClosed   ReviewCaseStatus = "CLOSED"
)

// ReviewCase is the finance-only review work item. ReceiptID is empty only
// for compatibility with review cases created before the receipt queue.
type ReviewCase struct {
	ID                    string
	ClaimID               string
	ReceiptID             string
	ClaimNumber           string
	ClaimPurpose          string
	Kind                  string
	ReasonCode            string
	Status                ReviewCaseStatus
	AssignedTo            string
	AssignedToDisplayName string
	ClaimedAt             *time.Time
	Resolution            string
	ResolvedBy            string
	CreatedAt             time.Time
	ResolvedAt            *time.Time
	UpdatedAt             time.Time
	Version               int64
}

// ReviewCaseView is intentionally separate from persistence so HTTP handlers
// can later choose the finance-safe fields they publish.
type ReviewCaseView struct {
	ID                    string           `json:"id"`
	ClaimID               string           `json:"claimId"`
	ReceiptID             string           `json:"receiptId"`
	ClaimNumber           string           `json:"claimNumber"`
	ClaimPurpose          string           `json:"claimPurpose"`
	Kind                  string           `json:"kind"`
	ReasonCode            string           `json:"reasonCode"`
	Status                ReviewCaseStatus `json:"status"`
	AssignedTo            string           `json:"assignedTo"`
	AssignedToDisplayName string           `json:"assignedToDisplayName"`
	ClaimedAt             *time.Time       `json:"claimedAt"`
	Resolution            string           `json:"resolution"`
	ResolvedBy            string           `json:"resolvedBy"`
	CreatedAt             time.Time        `json:"createdAt"`
	ResolvedAt            *time.Time       `json:"resolvedAt"`
	UpdatedAt             time.Time        `json:"updatedAt"`
	Version               int64            `json:"version"`
}

type ClaimReviewCaseCommand struct {
	CaseID          string
	ExpectedVersion int64
}

type ResolveReceiptCaseCommand struct {
	CaseID          string
	ExpectedVersion int64
	Action          ReviewCaseAction
	Resolution      string
	InvoiceNumber   string
	InvoiceDate     *time.Time
	TotalAmountCent *int64
	SellerName      *string
}

type ReviewCaseAction string

const (
	ReviewCaseActionConfirm         ReviewCaseAction = "CONFIRM"
	ReviewCaseActionCorrectFields   ReviewCaseAction = "CORRECT_FIELDS"
	ReviewCaseActionRequestReupload ReviewCaseAction = "REQUEST_REUPLOAD"
	ReviewCaseActionCloseInvalid    ReviewCaseAction = "CLOSE_INVALID"
)

type ReviewCaseRepository interface {
	ListReceiptCases(context.Context) ([]ReviewCase, error)
	GetReceiptCase(context.Context, string) (ReviewCase, error)
	ClaimReceiptCase(context.Context, string, string, int64) (ReviewCase, error)
	ResolveReceiptCase(context.Context, string, ResolveReceiptCaseCommand, bool) (ReviewCase, error)
}

type ReviewCaseService struct{ repository ReviewCaseRepository }

func NewReviewCaseService(repository ReviewCaseRepository) *ReviewCaseService {
	return &ReviewCaseService{repository: repository}
}

func (service *ReviewCaseService) ListReceiptCases(ctx context.Context, role string) ([]ReviewCaseView, error) {
	if !canReviewReceipts(role) {
		return nil, ErrReviewCaseForbidden
	}
	cases, err := service.repository.ListReceiptCases(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]ReviewCaseView, 0, len(cases))
	for _, reviewCase := range cases {
		views = append(views, reviewCaseView(reviewCase))
	}
	return views, nil
}

func (service *ReviewCaseService) GetReceiptCase(ctx context.Context, role, caseID string) (ReviewCaseView, error) {
	if !canReviewReceipts(role) {
		return ReviewCaseView{}, ErrReviewCaseForbidden
	}
	if strings.TrimSpace(caseID) == "" {
		return ReviewCaseView{}, ErrInvalidReviewCase
	}
	reviewCase, err := service.repository.GetReceiptCase(ctx, caseID)
	if err != nil {
		return ReviewCaseView{}, err
	}
	return reviewCaseView(reviewCase), nil
}

func (service *ReviewCaseService) ClaimReceiptCase(ctx context.Context, actorID, role string, command ClaimReviewCaseCommand) (ReviewCaseView, error) {
	if !canReviewReceipts(role) {
		return ReviewCaseView{}, ErrReviewCaseForbidden
	}
	if strings.TrimSpace(actorID) == "" || strings.TrimSpace(command.CaseID) == "" || command.ExpectedVersion < 1 {
		return ReviewCaseView{}, ErrInvalidReviewCase
	}
	reviewCase, err := service.repository.ClaimReceiptCase(ctx, actorID, command.CaseID, command.ExpectedVersion)
	if err != nil {
		return ReviewCaseView{}, err
	}
	return reviewCaseView(reviewCase), nil
}

func (service *ReviewCaseService) ResolveReceiptCase(ctx context.Context, actorID, role string, command ResolveReceiptCaseCommand) (ReviewCaseView, error) {
	if !canReviewReceipts(role) {
		return ReviewCaseView{}, ErrReviewCaseForbidden
	}
	if strings.TrimSpace(actorID) == "" || strings.TrimSpace(command.CaseID) == "" || command.ExpectedVersion < 1 || strings.TrimSpace(command.Resolution) == "" {
		return ReviewCaseView{}, ErrInvalidReviewCase
	}
	if command.Action == "" {
		command.Action = ReviewCaseActionConfirm
	}
	if !validReviewCaseAction(command.Action) {
		return ReviewCaseView{}, ErrInvalidReviewCase
	}
	if role != "ADMIN" {
		current, err := service.repository.GetReceiptCase(ctx, command.CaseID)
		if err != nil {
			return ReviewCaseView{}, err
		}
		if current.Status != ReviewCaseClaimed || current.AssignedTo != actorID {
			return ReviewCaseView{}, ErrReviewCaseForbidden
		}
	}
	command.Resolution = strings.TrimSpace(command.Resolution)
	reviewCase, err := service.repository.ResolveReceiptCase(ctx, actorID, command, role == "ADMIN")
	if err != nil {
		return ReviewCaseView{}, err
	}
	return reviewCaseView(reviewCase), nil
}

// Resolve retains the former handler-facing method until the versioned finance
// review endpoints replace the legacy manual resolution form.
func (service *ReviewCaseService) Resolve(actorID, role, caseID, resolution string) error {
	current, err := service.GetReceiptCase(context.Background(), role, caseID)
	if err != nil {
		return err
	}
	_, err = service.ResolveReceiptCase(context.Background(), actorID, role, ResolveReceiptCaseCommand{
		CaseID:          caseID,
		ExpectedVersion: current.Version,
		Resolution:      resolution,
	})
	return err
}

func canReviewReceipts(role string) bool {
	return role == "FINANCE_REVIEWER" || role == "ADMIN"
}

func validReviewCaseAction(action ReviewCaseAction) bool {
	return action == ReviewCaseActionConfirm || action == ReviewCaseActionCorrectFields || action == ReviewCaseActionRequestReupload || action == ReviewCaseActionCloseInvalid
}

func reviewCaseView(reviewCase ReviewCase) ReviewCaseView {
	return ReviewCaseView{
		ID:                    reviewCase.ID,
		ClaimID:               reviewCase.ClaimID,
		ReceiptID:             reviewCase.ReceiptID,
		ClaimNumber:           reviewCase.ClaimNumber,
		ClaimPurpose:          reviewCase.ClaimPurpose,
		Kind:                  reviewCase.Kind,
		ReasonCode:            reviewCase.ReasonCode,
		Status:                reviewCase.Status,
		AssignedTo:            reviewCase.AssignedTo,
		AssignedToDisplayName: reviewCase.AssignedToDisplayName,
		ClaimedAt:             reviewCase.ClaimedAt,
		Resolution:            reviewCase.Resolution,
		ResolvedBy:            reviewCase.ResolvedBy,
		CreatedAt:             reviewCase.CreatedAt,
		ResolvedAt:            reviewCase.ResolvedAt,
		UpdatedAt:             reviewCase.UpdatedAt,
		Version:               reviewCase.Version,
	}
}

type MemoryReviewCaseRepository struct {
	mu    sync.Mutex
	Cases map[string]ReviewCase
}

func NewMemoryReviewCaseRepository(cases ...ReviewCase) *MemoryReviewCaseRepository {
	repository := &MemoryReviewCaseRepository{Cases: map[string]ReviewCase{}}
	for _, reviewCase := range cases {
		repository.Cases[reviewCase.ID] = reviewCase
	}
	return repository
}

func (repository *MemoryReviewCaseRepository) ListReceiptCases(_ context.Context) ([]ReviewCase, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	result := make([]ReviewCase, 0, len(repository.Cases))
	for _, reviewCase := range repository.Cases {
		if reviewCase.ReceiptID != "" {
			result = append(result, reviewCase)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].CreatedAt.Equal(result[right].CreatedAt) {
			return result[left].ID < result[right].ID
		}
		return result[left].CreatedAt.Before(result[right].CreatedAt)
	})
	return result, nil
}

func (repository *MemoryReviewCaseRepository) GetReceiptCase(_ context.Context, caseID string) (ReviewCase, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	reviewCase, ok := repository.Cases[caseID]
	if !ok || reviewCase.ReceiptID == "" {
		return ReviewCase{}, ErrReviewCaseNotFound
	}
	return reviewCase, nil
}

func (repository *MemoryReviewCaseRepository) ClaimReceiptCase(_ context.Context, actorID, caseID string, expectedVersion int64) (ReviewCase, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	reviewCase, ok := repository.Cases[caseID]
	if !ok || reviewCase.ReceiptID == "" {
		return ReviewCase{}, ErrReviewCaseNotFound
	}
	if reviewCase.Status != ReviewCaseOpen || reviewCase.Version != expectedVersion {
		return ReviewCase{}, ErrReviewCaseConflict
	}
	now := time.Now().UTC()
	reviewCase.Status = ReviewCaseClaimed
	reviewCase.AssignedTo = actorID
	reviewCase.ClaimedAt = &now
	reviewCase.UpdatedAt = now
	reviewCase.Version++
	repository.Cases[caseID] = reviewCase
	return reviewCase, nil
}

func (repository *MemoryReviewCaseRepository) ResolveReceiptCase(_ context.Context, actorID string, command ResolveReceiptCaseCommand, administratorTakeover bool) (ReviewCase, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	reviewCase, ok := repository.Cases[command.CaseID]
	if !ok || reviewCase.ReceiptID == "" {
		return ReviewCase{}, ErrReviewCaseNotFound
	}
	if reviewCase.Status != ReviewCaseClaimed || reviewCase.Version != command.ExpectedVersion || (!administratorTakeover && reviewCase.AssignedTo != actorID) {
		return ReviewCase{}, ErrReviewCaseConflict
	}
	now := time.Now().UTC()
	if command.Action == ReviewCaseActionRequestReupload || command.Action == ReviewCaseActionCloseInvalid {
		reviewCase.Status = ReviewCaseClosed
	} else {
		reviewCase.Status = ReviewCaseResolved
	}
	reviewCase.Resolution = command.Resolution
	reviewCase.ResolvedBy = actorID
	reviewCase.ResolvedAt = &now
	reviewCase.UpdatedAt = now
	reviewCase.Version++
	repository.Cases[command.CaseID] = reviewCase
	return reviewCase, nil
}

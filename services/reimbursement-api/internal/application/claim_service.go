package application

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

var (
	ErrClaimNotFound        = errors.New("claim not found")
	ErrClaimVersionConflict = errors.New("claim version conflict")
	ErrValidationBlocked    = errors.New("validation blocked")
)

type CreateClaimCommand struct {
	Purpose string
}

type PatchClaimCommand struct {
	Purpose               *string
	ExpenseCategory       *string
	Participants          *[]string
	ProjectCode           *string
	RequestedAmountCent   *int64
	Currency              *string
	Remark                *string
	UseOCRSuggestedAmount bool
	UnknownFields         []string
}

type ClaimView = domain.Claim

type ClaimRepository interface {
	Create(context.Context, domain.Claim, ClaimAudit, ClaimOutboxEvent) error
	FindOwned(context.Context, string, string) (domain.Claim, error)
	ListOwned(context.Context, string, int) ([]domain.Claim, error)
	Update(context.Context, domain.Claim, int64, ClaimAudit, ClaimOutboxEvent) error
	Delete(context.Context, string, string, int64, ClaimAudit, ClaimOutboxEvent) error
}

func (service *ClaimService) ListClaims(ctx context.Context, actorID string, limit int) ([]ClaimView, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	claims, err := service.repository.ListOwned(ctx, actorID, limit)
	if err != nil {
		return nil, fmt.Errorf("list claims: %w", err)
	}
	views := make([]ClaimView, 0, len(claims))
	for _, claim := range claims {
		views = append(views, claim.Clone())
	}
	return views, nil
}

type ClaimAudit struct {
	ClaimID string
	ActorID string
	Action  string
	Version int64
}

type ClaimOutboxEvent struct {
	ClaimID string
	Type    string
	Version int64
}

type IDGenerator interface {
	Next() string
}

type ClaimService struct {
	repository  ClaimRepository
	suggestions ClaimOCRSuggestionRefresher
	ids         IDGenerator
	numbers     ClaimNumberGenerator
	now         func() time.Time
}

func NewClaimService(repository ClaimRepository, ids IDGenerator, numbers ClaimNumberGenerator, now func() time.Time, suggestions ...ClaimOCRSuggestionRefresher) *ClaimService {
	var suggestionRefresher ClaimOCRSuggestionRefresher
	if len(suggestions) > 0 {
		suggestionRefresher = suggestions[0]
	}
	return &ClaimService{repository: repository, suggestions: suggestionRefresher, ids: ids, numbers: numbers, now: now}
}

func (service *ClaimService) CreateClaim(ctx context.Context, actorID string, command CreateClaimCommand) (ClaimView, error) {
	claimNumber, err := service.numbers.Next(ctx, service.now())
	if err != nil {
		return ClaimView{}, fmt.Errorf("allocate claim number: %w", err)
	}
	claim, err := domain.NewDraftClaim(service.ids.Next(), claimNumber, actorID, command.Purpose)
	if err != nil {
		return ClaimView{}, err
	}
	if err := service.repository.Create(ctx, claim, ClaimAudit{ClaimID: claim.ID, ActorID: actorID, Action: "CLAIM_DRAFT_CREATED", Version: claim.Version}, ClaimOutboxEvent{ClaimID: claim.ID, Type: "ClaimDraftCreated", Version: claim.Version}); err != nil {
		return ClaimView{}, fmt.Errorf("persist draft claim: %w", err)
	}
	return claim.Clone(), nil
}

func (service *ClaimService) GetClaim(ctx context.Context, actorID string, claimID string) (ClaimView, error) {
	claim, err := service.repository.FindOwned(ctx, claimID, actorID)
	if errors.Is(err, ErrClaimNotFound) {
		return ClaimView{}, ErrClaimNotFound
	}
	if err != nil {
		return ClaimView{}, fmt.Errorf("find claim: %w", err)
	}
	return claim.Clone(), nil
}

func (service *ClaimService) UpdateClaim(ctx context.Context, actorID string, claimID string, expectedVersion int64, command PatchClaimCommand) (ClaimView, error) {
	if len(command.UnknownFields) > 0 {
		return ClaimView{}, ErrValidationBlocked
	}
	claim, err := service.repository.FindOwned(ctx, claimID, actorID)
	if errors.Is(err, ErrClaimNotFound) {
		return ClaimView{}, ErrClaimNotFound
	}
	if err != nil {
		return ClaimView{}, fmt.Errorf("find claim: %w", err)
	}
	patch := domain.ClaimPatch{
		Purpose:               command.Purpose,
		ExpenseCategory:       command.ExpenseCategory,
		Participants:          command.Participants,
		ProjectCode:           command.ProjectCode,
		RequestedAmountCent:   command.RequestedAmountCent,
		Currency:              command.Currency,
		Remark:                command.Remark,
		UseOCRSuggestedAmount: command.UseOCRSuggestedAmount,
	}
	if err := claim.Patch(expectedVersion, patch); err != nil {
		if errors.Is(err, domain.ErrClaimVersionConflict) {
			return ClaimView{}, ErrClaimVersionConflict
		}
		return ClaimView{}, err
	}
	if err := service.repository.Update(ctx, claim, expectedVersion, ClaimAudit{ClaimID: claim.ID, ActorID: actorID, Action: "CLAIM_DRAFT_UPDATED", Version: claim.Version}, ClaimOutboxEvent{ClaimID: claim.ID, Type: "ClaimDraftUpdated", Version: claim.Version}); err != nil {
		if errors.Is(err, ErrClaimVersionConflict) {
			return ClaimView{}, ErrClaimVersionConflict
		}
		return ClaimView{}, fmt.Errorf("persist claim update: %w", err)
	}
	if command.UseOCRSuggestedAmount && service.suggestions != nil {
		if err := service.suggestions.RefreshOCRSuggestion(ctx, claim.ID, actorID); err != nil {
			return ClaimView{}, fmt.Errorf("refresh ocr suggested amount: %w", err)
		}
		return service.GetClaim(ctx, actorID, claim.ID)
	}
	return claim.Clone(), nil
}

func (service *ClaimService) DeleteClaim(ctx context.Context, actorID string, claimID string, expectedVersion int64) error {
	claim, err := service.repository.FindOwned(ctx, claimID, actorID)
	if errors.Is(err, ErrClaimNotFound) {
		return ErrClaimNotFound
	}
	if err != nil {
		return fmt.Errorf("find claim: %w", err)
	}
	if err := claim.CanDelete(expectedVersion); err != nil {
		if errors.Is(err, domain.ErrClaimVersionConflict) {
			return ErrClaimVersionConflict
		}
		return err
	}
	if err := service.repository.Delete(ctx, claimID, actorID, expectedVersion, ClaimAudit{ClaimID: claimID, ActorID: actorID, Action: "CLAIM_DRAFT_DELETED", Version: expectedVersion}, ClaimOutboxEvent{ClaimID: claimID, Type: "ClaimDraftDeleted", Version: expectedVersion}); err != nil {
		if errors.Is(err, ErrClaimVersionConflict) {
			return ErrClaimVersionConflict
		}
		return fmt.Errorf("delete draft claim: %w", err)
	}
	return nil
}

type MemoryClaimRepository struct {
	mu     sync.Mutex
	claims map[string]domain.Claim
	audits []ClaimAudit
	events []ClaimOutboxEvent
}

func NewMemoryClaimRepository() *MemoryClaimRepository {
	return &MemoryClaimRepository{claims: make(map[string]domain.Claim)}
}

func (repository *MemoryClaimRepository) Create(_ context.Context, claim domain.Claim, audit ClaimAudit, event ClaimOutboxEvent) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if _, exists := repository.claims[claim.ID]; exists {
		return ErrClaimVersionConflict
	}
	repository.claims[claim.ID] = claim.Clone()
	repository.audits = append(repository.audits, audit)
	repository.events = append(repository.events, event)
	return nil
}

func (repository *MemoryClaimRepository) FindOwned(_ context.Context, claimID string, actorID string) (domain.Claim, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	claim, exists := repository.claims[claimID]
	if !exists || claim.OwnerID != actorID {
		return domain.Claim{}, ErrClaimNotFound
	}
	return claim.Clone(), nil
}

func (repository *MemoryClaimRepository) ListOwned(_ context.Context, actorID string, limit int) ([]domain.Claim, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	claims := make([]domain.Claim, 0, limit)
	for _, claim := range repository.claims {
		if claim.OwnerID == actorID {
			claims = append(claims, claim.Clone())
		}
	}
	return claims, nil
}

func (repository *MemoryClaimRepository) Update(_ context.Context, claim domain.Claim, expectedVersion int64, audit ClaimAudit, event ClaimOutboxEvent) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	stored, exists := repository.claims[claim.ID]
	if !exists || stored.Version != expectedVersion {
		return ErrClaimVersionConflict
	}
	repository.claims[claim.ID] = claim.Clone()
	repository.audits = append(repository.audits, audit)
	repository.events = append(repository.events, event)
	return nil
}

func (repository *MemoryClaimRepository) Delete(_ context.Context, claimID string, actorID string, expectedVersion int64, audit ClaimAudit, event ClaimOutboxEvent) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	stored, exists := repository.claims[claimID]
	if !exists || stored.OwnerID != actorID || stored.Version != expectedVersion || stored.Status != domain.ClaimStatusDraft {
		return ErrClaimVersionConflict
	}
	delete(repository.claims, claimID)
	repository.audits = append(repository.audits, audit)
	repository.events = append(repository.events, event)
	return nil
}

func (repository *MemoryClaimRepository) SetStatusForTest(claimID string, status domain.ClaimStatus) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	claim, exists := repository.claims[claimID]
	if !exists {
		return ErrClaimNotFound
	}
	claim.Status = status
	repository.claims[claimID] = claim
	return nil
}

type SequentialIDGenerator struct {
	mu   sync.Mutex
	next int
}

type SecureIDGenerator struct{}

func (SecureIDGenerator) Next() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "claim-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return "claim-" + hex.EncodeToString(bytes)
}

func NewSequentialIDGenerator() *SequentialIDGenerator { return &SequentialIDGenerator{} }

func (generator *SequentialIDGenerator) Next() string {
	generator.mu.Lock()
	defer generator.mu.Unlock()
	generator.next++
	return "claim-" + strconv.Itoa(generator.next)
}

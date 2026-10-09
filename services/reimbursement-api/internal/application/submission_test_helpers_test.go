package application

import (
	"context"
	"fmt"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

type fakeSubmissionRepository struct {
	claim         domain.Claim
	receipts      []domain.Receipt
	confirmations map[string]SubmissionConfirmation
	submissions   map[string]SubmissionSnapshot
	submitCalls   int
}

func newFakeSubmissionRepository() *fakeSubmissionRepository {
	return &fakeSubmissionRepository{confirmations: make(map[string]SubmissionConfirmation), submissions: make(map[string]SubmissionSnapshot)}
}

func (repository *fakeSubmissionRepository) LoadSubmissionInput(_ context.Context, actorID string, claimID string) (SubmissionInput, error) {
	if repository.claim.ID != claimID || repository.claim.OwnerID != actorID {
		return SubmissionInput{}, ErrClaimNotFound
	}
	return SubmissionInput{Claim: repository.claim, Receipts: append([]domain.Receipt(nil), repository.receipts...)}, nil
}

func (repository *fakeSubmissionRepository) StoreConfirmation(_ context.Context, confirmation SubmissionConfirmation) error {
	repository.confirmations[confirmation.Token] = confirmation
	return nil
}

func (repository *fakeSubmissionRepository) FindConfirmation(_ context.Context, token string) (SubmissionConfirmation, error) {
	confirmation, found := repository.confirmations[token]
	if !found {
		return SubmissionConfirmation{}, ErrClaimNotFound
	}
	return confirmation, nil
}

func (repository *fakeSubmissionRepository) FindSubmissionByIdempotencyKey(_ context.Context, actorID string, claimID string, key string) (SubmissionSnapshot, error) {
	snapshot, found := repository.submissions[actorID+":"+claimID+":"+key]
	if !found {
		return SubmissionSnapshot{}, ErrClaimNotFound
	}
	return snapshot, nil
}

func (repository *fakeSubmissionRepository) Submit(_ context.Context, input SubmissionInput, confirmation SubmissionConfirmation, idempotencyKey string, policyVersion string) (SubmissionSnapshot, error) {
	if input.Claim.Version != confirmation.ClaimVersion {
		return SubmissionSnapshot{}, ErrStaleSubmissionConfirmation
	}
	repository.submitCalls++
	repository.claim.Status = domain.ClaimStatusSubmitted
	snapshot := SubmissionSnapshot{ClaimID: input.Claim.ID, SubmissionNumber: fmt.Sprintf("SUB-%03d", repository.submitCalls), ClaimVersion: input.Claim.Version, PolicyVersion: policyVersion}
	repository.submissions[input.Claim.OwnerID+":"+input.Claim.ID+":"+idempotencyKey] = snapshot
	return snapshot, nil
}

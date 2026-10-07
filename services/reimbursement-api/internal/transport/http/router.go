package transport

import (
	"context"
	"net/http"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type ClaimService interface {
	CreateClaim(ctx context.Context, actorID string, command application.CreateClaimCommand) (application.ClaimView, error)
	ListClaims(ctx context.Context, actorID string, limit int) ([]application.ClaimView, error)
	GetClaim(ctx context.Context, actorID string, claimID string) (application.ClaimView, error)
	UpdateClaim(ctx context.Context, actorID string, claimID string, expectedVersion int64, command application.PatchClaimCommand) (application.ClaimView, error)
}

type SubmissionService interface {
	ValidateClaim(ctx context.Context, actorID string, claimID string) (application.ValidationResult, error)
	RequestSubmission(ctx context.Context, actorID string, claimID string, expectedVersion int64) (application.SubmissionConfirmation, error)
	SubmitClaim(ctx context.Context, actorID string, claimID string, confirmationToken string, idempotencyKey string) (application.SubmissionSnapshot, error)
}

type ReceiptService interface {
	CreateUploadSession(ctx context.Context, actorID string, claimID string, command application.CreateUploadSessionCommand) (application.UploadSession, error)
	FinalizeReceiptUpload(ctx context.Context, actorID string, claimID string, receiptID string) error
	ListReceipts(ctx context.Context, actorID string, claimID string) ([]application.ReceiptView, error)
}

type Dependencies struct {
	Claims      ClaimService
	Submissions SubmissionService
	Receipts    ReceiptService
	Auth        ActorResolver
}

func NewRouter(dependencies Dependencies) http.Handler {
	mux := http.NewServeMux()
	handler := &claimsHandler{claims: dependencies.Claims, submissions: dependencies.Submissions, receipts: dependencies.Receipts}
	mux.HandleFunc("POST /api/v1/claims", handler.createClaim)
	mux.HandleFunc("GET /api/v1/claims", handler.listClaims)
	mux.HandleFunc("GET /api/v1/claims/{claimId}", handler.getClaim)
	mux.HandleFunc("GET /api/v1/claims/{claimId}/validation", handler.validateClaim)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/uploads", handler.createUploadSession)
	mux.HandleFunc("GET /api/v1/claims/{claimId}/receipts", handler.listReceipts)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/receipts", handler.finalizeReceiptUpload)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/submission-requests", handler.requestSubmission)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/submit", handler.submitClaim)
	mux.HandleFunc("GET /healthz", func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) })
	if dependencies.Auth == nil {
		dependencies.Auth = StaticActorResolver{}
	}
	return Authenticate(dependencies.Auth, mux)
}

func pathClaimID(request *http.Request) string {
	return strings.TrimSpace(request.PathValue("claimId"))
}

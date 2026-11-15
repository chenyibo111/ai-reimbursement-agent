package transport

import (
	"context"
	"net/http"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

type ClaimService interface {
	CreateClaim(ctx context.Context, actorID string, command application.CreateClaimCommand) (application.ClaimView, error)
	ListClaims(ctx context.Context, actorID string, limit int) ([]application.ClaimView, error)
	FindClaimByNumber(ctx context.Context, actorID string, claimNumber string) (application.ClaimView, error)
	GetClaim(ctx context.Context, actorID string, claimID string) (application.ClaimView, error)
	UpdateClaim(ctx context.Context, actorID string, claimID string, expectedVersion int64, command application.PatchClaimCommand) (application.ClaimView, error)
}

type SubmissionService interface {
	ValidateClaim(ctx context.Context, actorID string, claimID string) (application.ValidationResult, error)
	RequestSubmission(ctx context.Context, actorID string, claimID string, expectedVersion int64) (application.SubmissionConfirmation, error)
	SubmitClaim(ctx context.Context, actorID string, claimID string, confirmationToken string, idempotencyKey string) (application.SubmissionSnapshot, error)
}

type ClaimProgressService interface {
	GetClaimProgress(ctx context.Context, actorID string, claimID string) (application.ClaimProgress, error)
}

type ReceiptService interface {
	CreateUploadSession(ctx context.Context, actorID string, claimID string, command application.CreateUploadSessionCommand) (application.UploadSession, error)
	FinalizeReceiptUpload(ctx context.Context, actorID string, claimID string, receiptID string) error
	DeleteReceipt(ctx context.Context, actorID string, claimID string, receiptID string) error
	ListReceipts(ctx context.Context, actorID string, claimID string) ([]application.ReceiptView, error)
}

type ExpenseItemService interface {
	ListOwnedByClaim(context.Context, string, string) ([]domain.ExpenseItem, error)
	PatchOwnedDraft(context.Context, string, string, string, int64, domain.ExpenseItemPatch) (domain.ExpenseItem, error)
}

type Dependencies struct {
	Claims             ClaimService
	Submissions        SubmissionService
	Progress           ClaimProgressService
	Receipts           ReceiptService
	ExpenseItems       ExpenseItemService
	Auth               ActorResolver
	AuthBFF            http.Handler
	Admin              AdminServices
	Configs            *application.ConfigService
	PolicySources      http.Handler
	EmployeeIdentities EmployeeIdentityService
	ProvisioningKey    string
	Members            interface {
		ResolveMember(context.Context, store.MemberIdentity) (store.EmployeeIdentity, error)
	}
	BotAppID  string
	TenantKey string
}

func NewRouter(dependencies Dependencies) http.Handler {
	mux := http.NewServeMux()
	handler := &claimsHandler{claims: dependencies.Claims, submissions: dependencies.Submissions, progress: dependencies.Progress, receipts: dependencies.Receipts, expenseItems: dependencies.ExpenseItems}
	mux.HandleFunc("POST /api/v1/claims", handler.createClaim)
	mux.HandleFunc("GET /api/v1/claims", handler.listClaims)
	mux.HandleFunc("GET /api/v1/claims/{claimId}", handler.getClaim)
	mux.HandleFunc("PATCH /api/v1/claims/{claimId}", handler.patchClaim)
	mux.HandleFunc("PATCH /api/v1/claims/{claimId}/items/{itemId}", handler.patchExpenseItem)
	mux.HandleFunc("DELETE /api/v1/claims/{claimId}", handler.deleteClaim)
	mux.HandleFunc("GET /api/v1/claims/{claimId}/validation", handler.validateClaim)
	mux.HandleFunc("GET /api/v1/claims/{claimId}/progress", handler.getClaimProgress)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/uploads", handler.createUploadSession)
	mux.HandleFunc("GET /api/v1/claims/{claimId}/receipts", handler.listReceipts)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/receipts", handler.finalizeReceiptUpload)
	mux.HandleFunc("DELETE /api/v1/claims/{claimId}/receipts/{receiptId}", handler.deleteReceipt)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/submission-requests", handler.requestSubmission)
	mux.HandleFunc("POST /api/v1/claims/{claimId}/submit", handler.submitClaim)
	if dependencies.Admin.Policies != nil && dependencies.Admin.Reviews != nil && dependencies.Admin.Role != nil {
		admin := &adminHandler{services: dependencies.Admin}
		mux.HandleFunc("POST /api/v1/admin/policies/publish", admin.publishPolicy)
		mux.HandleFunc("GET /api/v1/admin/reviews", admin.listReviews)
		mux.HandleFunc("GET /api/v1/admin/reviews/{reviewId}", admin.getReview)
		if dependencies.Admin.Previews != nil {
			mux.HandleFunc("GET /api/v1/admin/reviews/{reviewId}/receipt-preview", admin.previewReceipt)
		}
		mux.HandleFunc("POST /api/v1/admin/reviews/{reviewId}/claim", admin.claimReview)
		mux.HandleFunc("POST /api/v1/admin/reviews/{reviewId}/resolve", admin.resolveReview)
	}
	if dependencies.PolicySources != nil {
		mux.Handle("/api/v1/admin/policy-sources", dependencies.PolicySources)
		mux.Handle("/api/v1/admin/policy-sources/", dependencies.PolicySources)
	}
	if dependencies.Configs != nil {
		config := &configHandler{service: dependencies.Configs, role: dependencies.Admin.Role, serviceKey: []byte(dependencies.ProvisioningKey)}
		mux.HandleFunc("GET /api/v1/admin/config/{domain}", config.getAdmin)
		mux.HandleFunc("POST /api/v1/admin/config/{domain}/draft", config.saveDraft)
		mux.HandleFunc("POST /api/v1/admin/config/{domain}/preview", config.preview)
		mux.HandleFunc("POST /api/v1/admin/config/{domain}/approve", config.approve)
		mux.HandleFunc("POST /api/v1/admin/config/{domain}/publish", config.publish)
		mux.HandleFunc("GET /api/v1/admin/config/{domain}/history", config.history)
		mux.HandleFunc("POST /api/v1/admin/config/{domain}/activate", config.activate)
		mux.HandleFunc("GET /api/v1/config/{domain}", config.getPublic)
	}
	mux.HandleFunc("GET /healthz", func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) })
	if dependencies.Auth == nil {
		dependencies.Auth = StaticActorResolver{}
	}
	public := Authenticate(dependencies.Auth, mux)
	internal := http.NewServeMux()
	if dependencies.EmployeeIdentities != nil && strings.TrimSpace(dependencies.ProvisioningKey) != "" {
		handler := &internalEmployeeHandler{service: dependencies.EmployeeIdentities, provisioningKey: []byte(dependencies.ProvisioningKey)}
		internal.HandleFunc("PUT /internal/v1/employees/{employeeId}", handler.upsert)
	}
	if dependencies.Members != nil && strings.TrimSpace(dependencies.ProvisioningKey) != "" {
		memberHandler := &internalMemberHandler{members: dependencies.Members, serviceKey: []byte(dependencies.ProvisioningKey), botAppID: dependencies.BotAppID, tenantKey: dependencies.TenantKey}
		internal.HandleFunc("POST /internal/v1/employee-identities/resolve", memberHandler.resolve)
	}
	if dependencies.Configs != nil && strings.TrimSpace(dependencies.ProvisioningKey) != "" {
		config := &configHandler{service: dependencies.Configs, serviceKey: []byte(dependencies.ProvisioningKey)}
		internal.HandleFunc("GET /internal/v1/config/{domain}/active", config.getInternal)
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/api/auth/") && dependencies.AuthBFF != nil {
			dependencies.AuthBFF.ServeHTTP(response, request)
			return
		}
		if strings.HasPrefix(request.URL.Path, "/internal/") {
			internal.ServeHTTP(response, request)
			return
		}
		public.ServeHTTP(response, request)
	})
}

func pathClaimID(request *http.Request) string {
	return strings.TrimSpace(request.PathValue("claimId"))
}

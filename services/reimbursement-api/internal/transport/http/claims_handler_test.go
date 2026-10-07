package transport

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestCreateClaimRequiresAuthenticationAndIdempotencyKey(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/claims", bytes.NewBufferString(`{"purpose":"客户拜访"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/claims", bytes.NewBufferString(`{"purpose":"客户拜访"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer employee-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected missing idempotency key to return 400, got %d", response.Code)
	}
}

func TestHS256BearerResolverRejectsWrongAudienceAndAcceptsEmployeeSubject(t *testing.T) {
	resolver, err := NewHS256BearerResolver("test-secret", "reimbursement-api")
	if err != nil {
		t.Fatalf("create resolver: %v", err)
	}
	resolver.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "aud": "reimbursement-api", "exp": resolver.now() + 60}))
	actor, err := resolver.Resolve(request)
	if err != nil || actor.ID != "employee-1" {
		t.Fatalf("expected employee actor, got %#v err=%v", actor, err)
	}
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "aud": "other", "exp": resolver.now() + 60}))
	if _, err = resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected unauthenticated, got %v", err)
	}
}

func TestDelegatedAgentResolverRequiresServiceKeyJTIChannelAndActiveEmployee(t *testing.T) {
	bearer, _ := NewHS256BearerResolver("test-secret", "reimbursement-api")
	bearer.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	resolver, err := NewDelegatedAgentResolver(bearer, "agent-key", EmployeeActivityFunc(func(context.Context, string) (bool, error) { return true, nil }))
	if err != nil { t.Fatalf("create delegated resolver: %v", err) }
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Agent-Service-Key", "agent-key")
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub":"employee-1","aud":"reimbursement-api","exp":bearer.now()+60,"jti":"tool-call-1","channel":"agent"}))
	actor, err := resolver.Resolve(request)
	if err != nil || actor.ID != "employee-1" { t.Fatalf("expected delegated employee, got %#v err=%v", actor, err) }
	request.Header.Set("X-Agent-Service-Key", "wrong")
	if _, err = resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) { t.Fatalf("expected key rejection, got %v", err) }
}

func signedTestToken(secret string, claims map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, _ := json.Marshal(claims)
	signed := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestSubmitClaimReturnsValidationBlockedWithoutLeakingInternals(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Submissions: fakeSubmissions{err: application.ErrValidationBlocked}, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/claims/claim-1/submit", bytes.NewBufferString(`{"confirmationToken":"token"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer employee-1")
	request.Header.Set("Idempotency-Key", "key-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", response.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["code"] != "VALIDATION_BLOCKED" || body["message"] == "validation blocked" {
		t.Fatalf("unexpected safe error: %#v", body)
	}
}

type fakeClaims struct{}

func (fakeClaims) CreateClaim(_ context.Context, actor string, command application.CreateClaimCommand) (application.ClaimView, error) {
	return application.ClaimView{ID: "claim-1", OwnerID: actor, Status: domain.ClaimStatusDraft, Purpose: command.Purpose, Version: 1}, nil
}
func (fakeClaims) GetClaim(context.Context, string, string) (application.ClaimView, error) {
	return application.ClaimView{}, application.ErrClaimNotFound
}
func (fakeClaims) UpdateClaim(context.Context, string, string, int64, application.PatchClaimCommand) (application.ClaimView, error) {
	return application.ClaimView{}, application.ErrClaimNotFound
}

type fakeSubmissions struct{ err error }

func (service fakeSubmissions) ValidateClaim(context.Context, string, string) (application.ValidationResult, error) {
	return application.ValidationResult{}, service.err
}
func (service fakeSubmissions) RequestSubmission(context.Context, string, string, int64) (application.SubmissionConfirmation, error) {
	return application.SubmissionConfirmation{}, service.err
}
func (service fakeSubmissions) SubmitClaim(context.Context, string, string, string, string) (application.SubmissionSnapshot, error) {
	return application.SubmissionSnapshot{}, service.err
}

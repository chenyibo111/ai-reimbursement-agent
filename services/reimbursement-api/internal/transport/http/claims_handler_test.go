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

func TestWebBearerResolverRejectsCrossChannelMalformedAndUntrustedClaims(t *testing.T) {
	resolver, err := NewWebBearerResolver("test-secret", "reimbursement-api")
	if err != nil {
		t.Fatalf("create resolver: %v", err)
	}
	resolver.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "iat": resolver.now() - 1, "channel": "web", "exp": resolver.now() + 60}))
	actor, err := resolver.Resolve(request)
	if err != nil || actor.ID != "employee-1" || actor.Role != "EMPLOYEE" || actor.Channel != "web" {
		t.Fatalf("expected employee actor, got %#v err=%v", actor, err)
	}
	for _, claims := range []map[string]any{
		{"sub": "employee-1", "role": "EMPLOYEE", "aud": "other", "channel": "web", "exp": resolver.now() + 60},
		{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "channel": "agent", "exp": resolver.now() + 60},
		{"sub": "employee-1", "role": "UNKNOWN", "aud": "reimbursement-api", "channel": "web", "exp": resolver.now() + 60},
		{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "iat": 0, "channel": "web", "exp": resolver.now() + 60},
		{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "channel": "web", "exp": resolver.now() - 1},
	} {
		request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", claims))
		if _, err = resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("expected unauthenticated for %#v, got %v", claims, err)
		}
	}
	request.Header.Set("Authorization", "Bearer "+signedTestToken("wrong-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "channel": "web", "exp": resolver.now() + 60}))
	if _, err = resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected signed token rejection, got %v", err)
	}
}

func TestWebBearerResolverRejectsInactiveEmployee(t *testing.T) {
	resolver, err := NewWebBearerResolver("test-secret", "reimbursement-api", EmployeeActivityFunc(func(context.Context, string) (bool, error) { return false, nil }))
	if err != nil {
		t.Fatalf("create resolver: %v", err)
	}
	resolver.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	request := httptest.NewRequest(http.MethodPost, "/api/v1/claims", nil)
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "iat": resolver.now() - 1, "channel": "web", "exp": resolver.now() + 60}))
	if _, err = resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected inactive employee rejection, got %v", err)
	}
}

func TestDelegatedAgentResolverRequiresServiceKeyJTIChannelAndActiveEmployee(t *testing.T) {
	bearer, _ := NewHS256BearerResolver("test-secret", "reimbursement-api")
	bearer.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	resolver, err := NewDelegatedAgentResolver(bearer, "agent-key", EmployeeActivityFunc(func(context.Context, string) (bool, error) { return true, nil }))
	if err != nil {
		t.Fatalf("create delegated resolver: %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Agent-Service-Key", "agent-key")
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "iat": bearer.now() - 1, "exp": bearer.now() + 60, "jti": "tool-call-1", "channel": "agent"}))
	actor, err := resolver.Resolve(request)
	if err != nil || actor.ID != "employee-1" {
		t.Fatalf("expected delegated employee, got %#v err=%v", actor, err)
	}
	request.Header.Set("X-Agent-Service-Key", "wrong")
	if _, err = resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected key rejection, got %v", err)
	}
}

func TestCombinedActorResolverDoesNotTreatWebTokenAsDelegatedAgent(t *testing.T) {
	web, _ := NewWebBearerResolver("test-secret", "reimbursement-api")
	web.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	base, _ := NewHS256BearerResolver("test-secret", "reimbursement-api")
	base.now = web.now
	agent, _ := NewDelegatedAgentResolver(base, "agent-key", EmployeeActivityFunc(func(context.Context, string) (bool, error) { return true, nil }))
	resolver := NewCombinedActorResolver(web, agent)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Agent-Service-Key", "agent-key")
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "iat": web.now() - 1, "channel": "web", "exp": web.now() + 60}))
	if _, err := resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected web token to be rejected as delegated agent, got %v", err)
	}
}

func TestAdminAuthorizationRequiresMatchingTokenAndStoredRole(t *testing.T) {
	handler := &adminHandler{services: AdminServices{Role: func(context.Context, string) (string, error) { return "ADMIN", nil }}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/policies/publish", nil)
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "employee-1", Role: "FINANCE_REVIEWER", Channel: "web"}))
	if _, ok := handler.authorize(request); ok {
		t.Fatal("expected mismatched token and stored role to be forbidden")
	}
}

func TestAdminAuthorizationRejectsOrdinaryEmployee(t *testing.T) {
	handler := &adminHandler{services: AdminServices{Role: func(context.Context, string) (string, error) { return "EMPLOYEE", nil }}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/policies/publish", nil)
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "employee-1", Role: "EMPLOYEE", Channel: "web"}))
	if _, ok := handler.authorize(request); ok {
		t.Fatal("expected ordinary employee to be forbidden from policy publishing and review resolution")
	}
}

func TestInternalEmployeeProvisioningRequiresDedicatedKey(t *testing.T) {
	service := &fakeEmployeeIdentityService{}
	handler := NewRouter(Dependencies{EmployeeIdentities: service, ProvisioningKey: "provision-key", Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodPut, "/internal/v1/employees/employee-1", bytes.NewBufferString(`{"displayName":"飞书员工","feishuOpenId":"ou-employee","role":"EMPLOYEE","isActive":true}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Auth-Provisioning-Key", "provision-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", response.Code)
	}
	if service.command.EmployeeID != "employee-1" || service.command.FeishuOpenID != "ou-employee" {
		t.Fatalf("command = %#v", service.command)
	}
	request.Header.Set("X-Auth-Provisioning-Key", "agent-key")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected dedicated key rejection, got %d", response.Code)
	}
}

type fakeEmployeeIdentityService struct {
	command application.EmployeeIdentityCommand
}

func (service *fakeEmployeeIdentityService) Upsert(_ context.Context, command application.EmployeeIdentityCommand) error {
	service.command = command
	return nil
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

func TestGetClaimReturnsActorScopedClaim(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/claims/claim-1", nil)
	request.Header.Set("Authorization", "Bearer employee-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["id"] != "claim-1" || body["ownerId"] != "employee-1" {
		t.Fatalf("unexpected claim response: %#v", body)
	}
	if body["claimNumber"] != "BX20261008-0001" || body["receiptCount"] != float64(3) || body["recognizedReceiptCount"] != float64(2) || body["totalAmountCent"] != float64(10155) || body["missingAmountReceiptCount"] != float64(1) {
		t.Fatalf("claim summary metadata missing from response: %#v", body)
	}
}

func TestListClaimsReturnsOnlyAuthenticatedActorsClaims(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/claims", nil)
	request.Header.Set("Authorization", "Bearer employee-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
}

func TestListReceiptsReturnsOnlyReceiptsBelongingToTheAuthenticatedClaim(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Receipts: fakeReceipts{}, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/claims/claim-1/receipts", nil)
	request.Header.Set("Authorization", "Bearer employee-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Items) != 1 || body.Items[0]["id"] != "receipt-1" || body.Items[0]["objectKey"] != nil {
		t.Fatalf("unexpected safe receipt response: %#v", body.Items)
	}
	if body.Items[0]["invoiceDate"] != "2026-05-01" || body.Items[0]["totalAmountCent"] != float64(10155) || body.Items[0]["sellerName"] != "上海象鲜网络科技有限公司" {
		t.Fatalf("receipt metadata missing from response: %#v", body.Items[0])
	}
}

func TestReceiptResponseKeepsMissingMetadataNull(t *testing.T) {
	encoded, err := json.Marshal(receiptResponse(application.ReceiptView{ID: "receipt-1", ClaimID: "claim-1", Filename: "pending.pdf"}))
	if err != nil {
		t.Fatalf("encode receipt response: %v", err)
	}
	var response map[string]any
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatalf("decode receipt response: %v", err)
	}
	for _, field := range []string{"invoiceDate", "totalAmountCent", "sellerName"} {
		if value, ok := response[field]; !ok || value != nil {
			t.Fatalf("expected %s to be explicitly null, got %#v", field, response)
		}
	}
}

func TestPatchClaimUpdatesOnlyWhitelistedFieldsAtExpectedVersion(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/claims/claim-1", bytes.NewBufferString(`{"version":1,"purpose":"上海客户拜访"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer employee-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["purpose"] != "上海客户拜访" || body["version"] != float64(2) {
		t.Fatalf("unexpected patched claim: %#v", body)
	}
}

func TestPatchClaimAcceptsClaimApplicationFields(t *testing.T) {
	claims := &capturingApplicationClaims{}
	handler := NewRouter(Dependencies{Claims: claims, Auth: StaticActorResolver{}})
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/claims/claim-1", bytes.NewBufferString(`{"version":1,"requestedAmountCent":10155,"currency":"CNY","remark":"客户拜访交通费"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer employee-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", response.Code, response.Body.String())
	}
	if claims.command.RequestedAmountCent == nil || *claims.command.RequestedAmountCent != 10155 || claims.command.Currency == nil || *claims.command.Currency != "CNY" || claims.command.Remark == nil || *claims.command.Remark != "客户拜访交通费" {
		t.Fatalf("patch command = %#v", claims.command)
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["requestedAmountCent"] != float64(10155) || body["currency"] != "CNY" || body["requestedAmountSource"] != "MANUAL" || body["remark"] != "客户拜访交通费" {
		t.Fatalf("application response = %#v", body)
	}
}

func TestPatchClaimRejectsInvalidClaimApplicationFields(t *testing.T) {
	testCases := []struct {
		name string
		body string
	}{
		{name: "fractional cents", body: `{"version":1,"requestedAmountCent":101.55}`},
		{name: "exponent notation", body: `{"version":1,"requestedAmountCent":1e4}`},
		{name: "negative cents", body: `{"version":1,"requestedAmountCent":-1}`},
		{name: "unsupported currency", body: `{"version":1,"currency":"USD"}`},
		{name: "false restore", body: `{"version":1,"useOcrSuggestedAmount":false}`},
		{name: "conflicting amount and restore", body: `{"version":1,"requestedAmountCent":10155,"useOcrSuggestedAmount":true}`},
		{name: "unknown field", body: `{"version":1,"unexpected":true}`},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := NewRouter(Dependencies{Claims: &capturingApplicationClaims{}, Auth: StaticActorResolver{}})
			request := httptest.NewRequest(http.MethodPatch, "/api/v1/claims/claim-1", bytes.NewBufferString(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer employee-1")
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", response.Code, response.Body.String())
			}
			var body map[string]any
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if body["code"] != "INVALID_REQUEST" {
				t.Fatalf("error response = %#v", body)
			}
		})
	}
}

type fakeClaims struct{}

type capturingApplicationClaims struct {
	fakeClaims
	command application.PatchClaimCommand
}

func (claims *capturingApplicationClaims) UpdateClaim(_ context.Context, actorID string, claimID string, version int64, command application.PatchClaimCommand) (application.ClaimView, error) {
	if actorID != "employee-1" || claimID != "claim-1" || version != 1 {
		return application.ClaimView{}, application.ErrClaimNotFound
	}
	claims.command = command
	amount := int64(10155)
	return application.ClaimView{ID: claimID, ClaimNumber: "BX20261008-0001", OwnerID: actorID, Status: domain.ClaimStatusDraft, Purpose: "客户拜访", Version: 2, RequestedAmountCent: &amount, Currency: domain.ClaimCurrencyCNY, RequestedAmountSource: domain.RequestedAmountSourceManual, Remark: "客户拜访交通费"}, nil
}

func (fakeClaims) CreateClaim(_ context.Context, actor string, command application.CreateClaimCommand) (application.ClaimView, error) {
	return application.ClaimView{ID: "claim-1", OwnerID: actor, Status: domain.ClaimStatusDraft, Purpose: command.Purpose, Version: 1}, nil
}
func (fakeClaims) ListClaims(_ context.Context, actorID string, _ int) ([]application.ClaimView, error) {
	if actorID != "employee-1" {
		return nil, application.ErrClaimNotFound
	}
	return []application.ClaimView{{ID: "claim-1", OwnerID: actorID, Status: domain.ClaimStatusDraft, Purpose: "客户拜访", Version: 1}}, nil
}
func (fakeClaims) GetClaim(_ context.Context, actorID string, claimID string) (application.ClaimView, error) {
	if actorID != "employee-1" || claimID != "claim-1" {
		return application.ClaimView{}, application.ErrClaimNotFound
	}
	totalAmountCent := int64(10155)
	return application.ClaimView{ID: claimID, ClaimNumber: "BX20261008-0001", OwnerID: actorID, Status: domain.ClaimStatusDraft, Purpose: "客户拜访", Version: 1, ReceiptCount: 3, RecognizedReceiptCount: 2, TotalAmountCent: &totalAmountCent, MissingAmountReceiptCount: 1}, nil
}
func (fakeClaims) UpdateClaim(_ context.Context, actorID string, claimID string, version int64, command application.PatchClaimCommand) (application.ClaimView, error) {
	if actorID != "employee-1" || claimID != "claim-1" || version != 1 || command.Purpose == nil {
		return application.ClaimView{}, application.ErrClaimNotFound
	}
	return application.ClaimView{ID: claimID, OwnerID: actorID, Status: domain.ClaimStatusDraft, Purpose: *command.Purpose, Version: 2}, nil
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

type fakeReceipts struct{}

func (fakeReceipts) CreateUploadSession(context.Context, string, string, application.CreateUploadSessionCommand) (application.UploadSession, error) {
	return application.UploadSession{}, nil
}
func (fakeReceipts) FinalizeReceiptUpload(context.Context, string, string, string) error { return nil }
func (fakeReceipts) ListReceipts(_ context.Context, actorID string, claimID string) ([]application.ReceiptView, error) {
	if actorID != "employee-1" || claimID != "claim-1" {
		return nil, application.ErrClaimNotFound
	}
	invoiceDate := time.Date(2026, time.May, 1, 0, 0, 0, 0, time.UTC)
	totalAmountCent := int64(10155)
	sellerName := "上海象鲜网络科技有限公司"
	return []application.ReceiptView{{ID: "receipt-1", ClaimID: claimID, Filename: "hotel.png", Status: domain.ReceiptStatusExtracted, InvoiceNumber: "123", InvoiceDate: &invoiceDate, TotalAmountCent: &totalAmountCent, SellerName: &sellerName, OCRConfidence: 0.98}}, nil
}

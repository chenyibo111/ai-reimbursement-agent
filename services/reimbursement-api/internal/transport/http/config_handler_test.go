package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type configReadRepository struct{ application.ConfigRepository }

type employeeCatalogRepository struct{ application.ConfigRepository }

type employeeFormOptionsRepository struct{ application.ConfigRepository }
type employeeReviewLabelsRepository struct{ application.ConfigRepository }

type configPopulationStub struct{}

func (configPopulationStub) CountActiveEmployees(context.Context) (int, error) { return 42, nil }

func TestConfigHandlerRolloutAudienceRequiresAdminAndReturnsCount(t *testing.T) {
	service := application.NewConfigService(configReadRepository{})
	service.SetFeatureRolloutPopulationReader(configPopulationStub{})
	handler := &configHandler{service: service, role: func(context.Context, string) (string, error) { return "ADMIN", nil }}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/config/feature_rollout/audience", nil)
	response := httptest.NewRecorder()
	handler.rolloutAudience(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("anonymous audience=%d", response.Code)
	}
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "admin-1", Role: "ADMIN"}))
	response = httptest.NewRecorder()
	handler.rolloutAudience(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"activeEmployeeCount":42`) {
		t.Fatalf("admin audience=%d %s", response.Code, response.Body.String())
	}
}

func (employeeFormOptionsRepository) GetActive(context.Context, string) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: "form_options", Version: 4, Payload: []byte(`{"categoryHelpText":"请核对最终类别","projectCodeMode":"FREE_TEXT","projectCodes":[],"fieldOrder":["purpose","expenseCategory","projectCode","participants","requestedAmountCent","currency","remark"]}`)}, nil
}

func (employeeReviewLabelsRepository) GetActive(context.Context, string) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: "receipt_review", Version: 5, Payload: []byte(`{"lowOcrConfidenceThreshold":0.8,"reasonLabels":{"OCR_LOW_CONFIDENCE":"请核对票据内容"}}`)}, nil
}

func TestConfigHandlerEmployeeReadsReviewLabelsWithoutThreshold(t *testing.T) {
	service := application.NewConfigService(employeeReviewLabelsRepository{})
	service.RegisterValidator("receipt_review", application.ValidateReceiptReviewConfigPayload)
	handler := &configHandler{service: service}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/config/receipt_review_labels", nil)
	request.SetPathValue("domain", "receipt_review_labels")
	response := httptest.NewRecorder()
	handler.getPublic(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "请核对票据内容") || strings.Contains(response.Body.String(), "lowOcrConfidenceThreshold") {
		t.Fatalf("employee review labels=%d %s", response.Code, response.Body.String())
	}
}

func (employeeCatalogRepository) GetActive(context.Context, string) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: "expense_catalog", Version: 2, Payload: []byte(`{"categories":[{"code":"DINING","label":"餐饮费","enabled":true},{"code":"OLD","label":"旧类别","enabled":false}],"mappings":[{"receiptType":"DINING","categoryCode":"DINING","purposeTemplate":"餐饮费用"}]}`)}, nil
}

func (configReadRepository) GetActive(_ context.Context, configDomain string) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: configDomain, Version: 3, Payload: []byte(`{"categories":[]}`), PublishedAt: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}, nil
}

func (configReadRepository) GetVersion(_ context.Context, configDomain string, version int64) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: configDomain, Version: version, Payload: []byte(`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"{{body}}"}]}`)}, nil
}

func TestConfigHandlerInternalVersionRequiresServiceIdentity(t *testing.T) {
	service := application.NewConfigService(configReadRepository{})
	service.RegisterValidator("notification_templates", application.ValidateNotificationConfigPayload)
	handler := &configHandler{service: service, serviceKey: []byte("service-secret")}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/config/notification_templates/versions/3", nil)
	request.SetPathValue("domain", "notification_templates")
	request.SetPathValue("version", "3")
	response := httptest.NewRecorder()
	handler.getInternalVersion(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized version read=%d", response.Code)
	}
	request.Header.Set("X-Auth-Provisioning-Key", "service-secret")
	response = httptest.NewRecorder()
	handler.getInternalVersion(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":3`) {
		t.Fatalf("authorized version read=%d %s", response.Code, response.Body.String())
	}
}

func (configReadRepository) GetDraft(context.Context, string) (domain.ConfigDraft, error) {
	return domain.ConfigDraft{}, application.ErrConfigNotFound
}

func TestConfigHandlerRejectsNonAdminOnDraftAndHistory(t *testing.T) {
	for _, role := range []string{"EMPLOYEE", "FINANCE_REVIEWER"} {
		t.Run(role, func(t *testing.T) {
			handler := &configHandler{role: func(context.Context, string) (string, error) { return role, nil }}
			for _, configDomain := range []string{"expense_catalog", "form_options", "feature_rollout", "receipt_review", "notification_templates"} {
				for _, route := range []struct {
					method, path string
					handle       http.HandlerFunc
				}{
					{http.MethodGet, "/api/v1/admin/config/expense_catalog", handler.getAdmin},
					{http.MethodPost, "/api/v1/admin/config/expense_catalog/draft", handler.saveDraft},
					{http.MethodPost, "/api/v1/admin/config/expense_catalog/preview", handler.preview},
					{http.MethodPost, "/api/v1/admin/config/expense_catalog/approve", handler.approve},
					{http.MethodPost, "/api/v1/admin/config/expense_catalog/publish", handler.publish},
					{http.MethodPost, "/api/v1/admin/config/expense_catalog/activate", handler.activate},
					{http.MethodGet, "/api/v1/admin/config/expense_catalog/history", handler.history},
				} {
					request := httptest.NewRequest(route.method, route.path, nil)
					request.SetPathValue("domain", configDomain)
					request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "employee-1", Role: role}))
					response := httptest.NewRecorder()
					route.handle(response, request)
					if response.Code != http.StatusForbidden {
						t.Fatalf("%s %s: got %d", route.method, route.path, response.Code)
					}
				}
			}
		})
	}
}

func TestConfigHandlerRequiresMatchingStoredAdminRole(t *testing.T) {
	handler := &configHandler{role: func(context.Context, string) (string, error) { return "EMPLOYEE", nil }}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/config/expense_catalog", nil)
	request.SetPathValue("domain", "expense_catalog")
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "employee-1", Role: "ADMIN"}))
	response := httptest.NewRecorder()
	handler.getAdmin(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("stale admin token got %d", response.Code)
	}
}

func TestConfigHandlerInternalReadRequiresServiceIdentity(t *testing.T) {
	handler := &configHandler{serviceKey: []byte("service-secret")}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/config/expense_catalog/active", nil)
	request.SetPathValue("domain", "expense_catalog")
	response := httptest.NewRecorder()
	handler.getInternal(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing service key got %d", response.Code)
	}
}

func TestConfigHandlerInternalReadReturnsPublishedVersion(t *testing.T) {
	service := application.NewConfigService(configReadRepository{})
	service.RegisterValidator("expense_catalog", func(json.RawMessage) error { return nil })
	handler := &configHandler{service: service, serviceKey: []byte("service-secret")}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/config/expense_catalog/active", nil)
	request.SetPathValue("domain", "expense_catalog")
	request.Header.Set("X-Auth-Provisioning-Key", "service-secret")
	response := httptest.NewRecorder()
	handler.getInternal(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":3`) {
		t.Fatalf("internal read got %d %s", response.Code, response.Body.String())
	}
}

func TestConfigHandlerEmployeeReadHidesDisabledCategoriesAndMappings(t *testing.T) {
	service := application.NewConfigService(employeeCatalogRepository{})
	service.RegisterValidator("expense_catalog", func(json.RawMessage) error { return nil })
	handler := &configHandler{service: service}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/config/expense_catalog", nil)
	request.SetPathValue("domain", "expense_catalog")
	response := httptest.NewRecorder()
	handler.getPublic(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "餐饮费") || strings.Contains(response.Body.String(), "旧类别") || strings.Contains(response.Body.String(), "mappings") {
		t.Fatalf("employee catalog response=%d %s", response.Code, response.Body.String())
	}
}

func TestConfigHandlerEmployeeReadsPublishedFormOptions(t *testing.T) {
	service := application.NewConfigService(employeeFormOptionsRepository{})
	service.RegisterValidator("form_options", application.ValidateFormOptionsPayload)
	handler := &configHandler{service: service}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/config/form_options", nil)
	request.SetPathValue("domain", "form_options")
	response := httptest.NewRecorder()
	handler.getPublic(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":4`) || !strings.Contains(response.Body.String(), "请核对最终类别") {
		t.Fatalf("employee form options response=%d %s", response.Code, response.Body.String())
	}
}

func TestConfigHandlerRejectsUnknownFieldsAndLargePayload(t *testing.T) {
	handler := &configHandler{role: func(context.Context, string) (string, error) { return "ADMIN", nil }}
	for _, body := range []string{`{"expectedRevision":0,"payload":{},"unexpected":1}`, strings.Repeat("x", 70000)} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/config/expense_catalog/draft", strings.NewReader(body))
		request.SetPathValue("domain", "expense_catalog")
		request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "admin-1", Role: "ADMIN"}))
		response := httptest.NewRecorder()
		handler.saveDraft(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body got %d", response.Code)
		}
	}
}

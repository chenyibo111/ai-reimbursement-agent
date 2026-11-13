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

func (configReadRepository) GetActive(_ context.Context, configDomain string) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: configDomain, Version: 3, Payload: []byte(`{"categories":[]}`), PublishedAt: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}, nil
}

func (configReadRepository) GetDraft(context.Context, string) (domain.ConfigDraft, error) {
	return domain.ConfigDraft{}, application.ErrConfigNotFound
}

func TestConfigHandlerRejectsNonAdminOnDraftAndHistory(t *testing.T) {
	for _, role := range []string{"EMPLOYEE", "FINANCE_REVIEWER"} {
		t.Run(role, func(t *testing.T) {
			handler := &configHandler{role: func(context.Context, string) (string, error) { return role, nil }}
			for _, route := range []struct {
				method, path string
				handle       http.HandlerFunc
			}{
				{http.MethodGet, "/api/v1/admin/config/expense_catalog", handler.getAdmin},
				{http.MethodPost, "/api/v1/admin/config/expense_catalog/draft", handler.saveDraft},
				{http.MethodGet, "/api/v1/admin/config/expense_catalog/history", handler.history},
			} {
				request := httptest.NewRequest(route.method, route.path, nil)
				request.SetPathValue("domain", "expense_catalog")
				request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "employee-1", Role: role}))
				response := httptest.NewRecorder()
				route.handle(response, request)
				if response.Code != http.StatusForbidden {
					t.Fatalf("%s %s: got %d", route.method, route.path, response.Code)
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

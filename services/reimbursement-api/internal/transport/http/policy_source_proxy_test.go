package transport

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPolicySourceProxyRejectsNonAdminAndChangedRoles(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { upstreamCalls++; w.WriteHeader(200) }))
	defer upstream.Close()
	currentRole := "ADMIN"
	proxy, err := NewPolicySourceProxy(upstream.URL, "private-service-key", func(context.Context, string) (string, error) { return currentRole, nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range []Actor{{ID: "member", Role: "EMPLOYEE", Channel: "web"}, {ID: "reviewer", Role: "FINANCE_REVIEWER", Channel: "web"}, {ID: "agent", Role: "ADMIN", Channel: "agent"}} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/policy-sources", nil)
		request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, actor))
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("actor=%+v status=%d", actor, response.Code)
		}
	}
	currentRole = "EMPLOYEE"
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/policy-sources", nil)
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "former-admin", Role: "ADMIN", Channel: "web"}))
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || upstreamCalls != 0 {
		t.Fatalf("status=%d upstream=%d", response.Code, upstreamCalls)
	}
}

func TestPolicySourceProxyForwardsOnlyAuthenticatedIdentity(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/admin/policy-sources" || r.Header.Get("X-Agent-Admin-Service-Key") != "private-service-key" || r.Header.Get("X-Agent-Actor-ID") != "admin-real" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || string(body) != `{"title":"制度","url":"https://corp.feishu.cn/docx/Abcdef012345"}` {
			t.Errorf("unsafe forward: method=%s path=%s actor=%q authorization=%q cookie=%q body=%q", r.Method, r.URL.Path, r.Header.Get("X-Agent-Actor-ID"), r.Header.Get("Authorization"), r.Header.Get("Cookie"), body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"source-1"}`))
	}))
	defer upstream.Close()
	proxy, err := NewPolicySourceProxy(upstream.URL, "private-service-key", func(context.Context, string) (string, error) { return "ADMIN", nil })
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/policy-sources", strings.NewReader(`{"title":"制度","url":"https://corp.feishu.cn/docx/Abcdef012345"}`))
	request.Header.Set("X-Agent-Actor-ID", "forged")
	request.Header.Set("X-Agent-Admin-Service-Key", "forged")
	request.Header.Set("Authorization", "Bearer browser-token")
	request.Header.Set("Cookie", "private-session=secret")
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "admin-real", Role: "ADMIN", Channel: "web"}))
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || response.Body.String() != `{"id":"source-1"}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPolicySourceProxyFailsClosed(t *testing.T) {
	if _, err := NewPolicySourceProxy("http://agent-admin:8083", "", func(context.Context, string) (string, error) { return "ADMIN", nil }); err == nil {
		t.Fatal("missing service key accepted")
	}
	proxy, err := NewPolicySourceProxy("http://127.0.0.1:1", "private-service-key", func(context.Context, string) (string, error) { return "", errors.New("database unavailable") })
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/policy-sources", nil)
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "admin", Role: "ADMIN", Channel: "web"}))
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("role lookup failure status=%d", response.Code)
	}
}

func TestPolicySourceProxyReturnsUnavailableWithoutLeakingUpstream(t *testing.T) {
	proxy, err := NewPolicySourceProxy("http://127.0.0.1:1", "private-service-key", func(context.Context, string) (string, error) { return "ADMIN", nil })
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/policy-sources", nil)
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "admin", Role: "ADMIN", Channel: "web"}))
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "127.0.0.1") || strings.Contains(response.Body.String(), "private-service-key") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPolicySourceProxyRejectsUnknownPathAndOversizedBody(t *testing.T) {
	proxy, err := NewPolicySourceProxy("http://127.0.0.1:1", "private-service-key", func(context.Context, string) (string, error) { return "ADMIN", nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, testcase := range []struct {
		path, method, body string
		status             int
	}{
		{"/api/v1/admin/policy-sources/../../internal/secrets", http.MethodGet, "", http.StatusNotFound},
		{"/api/v1/admin/policy-sources?actor=admin", http.MethodGet, "", http.StatusNotFound},
		{"/api/v1/admin/policy-sources", http.MethodDelete, "", http.StatusNotFound},
		{"/api/v1/admin/policy-sources", http.MethodPost, strings.Repeat("x", policySourceBodyLimit+1), http.StatusRequestEntityTooLarge},
	} {
		request := httptest.NewRequest(testcase.method, testcase.path, strings.NewReader(testcase.body))
		request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, Actor{ID: "admin", Role: "ADMIN", Channel: "web"}))
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != testcase.status {
			t.Fatalf("path=%s status=%d body=%s", testcase.path, response.Code, response.Body.String())
		}
	}
}

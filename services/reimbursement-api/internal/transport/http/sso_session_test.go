package transport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWebBearerResolverChecksCentralSessionForEveryRequest(t *testing.T) {
	active := true
	checks := 0
	resolver, err := NewWebBearerResolver("test-secret", "reimbursement-api", EmployeeActivityFunc(func(context.Context, string) (bool, error) { return true, nil }), SSOSessionFunc(func(_ context.Context, sid string) (bool, error) {
		checks++
		if sid != "hydra-session-1" {
			t.Fatalf("sid=%q", sid)
		}
		return active, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	resolver.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	request := httptest.NewRequest(http.MethodGet, "/api/v1/claims", nil)
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "channel": "web", "sid": "hydra-session-1", "iat": resolver.now() - 1, "exp": resolver.now() + 60}))
	if _, err := resolver.Resolve(request); err != nil {
		t.Fatal(err)
	}
	active = false
	if _, err := resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked sid: %v", err)
	}
	if checks != 2 {
		t.Fatalf("central checks=%d", checks)
	}
}

func TestWebBearerResolverFailsClosedWhenSSOUnavailable(t *testing.T) {
	resolver, err := NewWebBearerResolver("test-secret", "reimbursement-api", EmployeeActivityFunc(func(context.Context, string) (bool, error) { return true, nil }), SSOSessionFunc(func(context.Context, string) (bool, error) { return false, errors.New("unavailable") }))
	if err != nil {
		t.Fatal(err)
	}
	resolver.now = func() int64 { return time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC).Unix() }
	request := httptest.NewRequest(http.MethodGet, "/api/v1/claims", nil)
	request.Header.Set("Authorization", "Bearer "+signedTestToken("test-secret", map[string]any{"sub": "employee-1", "role": "EMPLOYEE", "aud": "reimbursement-api", "channel": "web", "sid": "hydra-session-1", "iat": resolver.now() - 1, "exp": resolver.now() + 60}))
	if _, err := resolver.Resolve(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("SSO outage: %v", err)
	}
}

func TestHTTPSSOSessionCheckerSendsServiceKeyAndSid(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-SSO-Service-Key") != "test-service-key" {
			t.Errorf("request auth: %s %q", r.Method, r.Header.Get("X-SSO-Service-Key"))
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content type: %q", r.Header.Get("Content-Type"))
		}
		body := make([]byte, 100)
		n, _ := r.Body.Read(body)
		if string(body[:n]) != `{"sid":"hydra-session-1"}` {
			t.Errorf("body: %q", body[:n])
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	checker, err := NewHTTPSSOSessionChecker(server.URL, "test-service-key")
	if err != nil {
		t.Fatal(err)
	}
	active, err := checker.IsActive(context.Background(), "hydra-session-1")
	if err != nil || !active {
		t.Fatalf("active=%v err=%v", active, err)
	}
}

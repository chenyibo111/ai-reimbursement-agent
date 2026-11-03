package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/auth"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

type authBFFOIDC struct {
	identity    auth.VerifiedIdentity
	exchangeErr error
	endErr      error
}

func (fake *authBFFOIDC) Begin(_ context.Context, returnTo string) (auth.Authorization, error) {
	return auth.Authorization{
		URL:     "http://localhost:4444/oauth2/auth?state=expected-state",
		Pending: auth.PendingAuth{State: "expected-state", Nonce: "expected-nonce", Verifier: strings.Repeat("v", 43), ReturnTo: returnTo},
	}, nil
}
func (fake *authBFFOIDC) Exchange(_ context.Context, _ string, _ auth.PendingAuth) (auth.VerifiedIdentity, error) {
	return fake.identity, fake.exchangeErr
}
func (fake *authBFFOIDC) EndSession(_ context.Context, _ string) (url.URL, error) {
	return url.URL{Scheme: "http", Host: "localhost:4444", Path: "/oauth2/sessions/logout"}, fake.endErr
}

type authBFFLogoutVerifier struct {
	sid string
	err error
}

func (verifier *authBFFLogoutVerifier) Verify(_ context.Context, _ string) (string, error) {
	return verifier.sid, verifier.err
}

type authBFFSessionRows struct {
	rows map[string]store.SessionRecord
}

func (repository *authBFFSessionRows) PutSession(_ context.Context, record store.SessionRecord) error {
	repository.rows[record.IDHash] = record
	return nil
}
func (repository *authBFFSessionRows) FindSession(_ context.Context, hash string) (*store.SessionRecord, error) {
	row, ok := repository.rows[hash]
	if !ok {
		return nil, nil
	}
	return &row, nil
}
func (repository *authBFFSessionRows) DeleteSessionsBySID(_ context.Context, sid string) error {
	for hash, row := range repository.rows {
		if row.SID == sid {
			delete(repository.rows, hash)
		}
	}
	return nil
}

type authBFFEmployees struct {
	rows map[string]store.EmployeeIdentity
}

func (employees *authBFFEmployees) ResolveEmployee(_ context.Context, openID, displayName, role string) (store.EmployeeIdentity, error) {
	identity := store.EmployeeIdentity{ID: "employee-web-1", OpenID: openID, DisplayName: displayName, Role: role, IsActive: true}
	employees.rows[identity.ID] = identity
	return identity, nil
}
func (employees *authBFFEmployees) FindEmployeeByID(_ context.Context, id string) (*store.EmployeeIdentity, error) {
	identity, ok := employees.rows[id]
	if !ok {
		return nil, nil
	}
	return &identity, nil
}

type authBFFFixture struct {
	router      http.Handler
	oidc        *authBFFOIDC
	employees   *authBFFEmployees
	sessionRows *authBFFSessionRows
	status      *string
	verifier    *authBFFLogoutVerifier
}

func newAuthBFFFixture(t *testing.T, adminIDs string) *authBFFFixture {
	t.Helper()
	now := time.Now()
	status := "active"
	oidc := &authBFFOIDC{identity: auth.VerifiedIdentity{Subject: "fs_member", SID: "hydra-sid-1", FeishuOpenID: "ou_member", DisplayName: "测试成员", ExpiresAt: now.Add(time.Hour), IDToken: "signed-id-token"}}
	rows := &authBFFSessionRows{rows: make(map[string]store.SessionRecord)}
	sessions, err := auth.NewSessionService(rows, SSOSessionFunc(func(context.Context, string) (bool, error) {
		switch status {
		case "revoked":
			return false, nil
		case "outage":
			return false, errors.New("SSO unavailable")
		default:
			return true, nil
		}
	}), strings.Repeat("s", 32), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	employees := &authBFFEmployees{rows: make(map[string]store.EmployeeIdentity)}
	verifier := &authBFFLogoutVerifier{sid: "hydra-sid-1"}
	bff, err := NewAuthBFF(oidc, sessions, employees, AuthBFFConfig{
		SigningSecret: strings.Repeat("j", 32), AdminOpenIDs: adminIDs, FinanceOpenIDs: "ou_finance", SecureCookie: false, LogoutVerifier: verifier, PostLogoutURI: "http://localhost:8088/logged-out",
	})
	if err != nil {
		t.Fatal(err)
	}
	return &authBFFFixture{router: NewRouter(Dependencies{AuthBFF: bff, Auth: StaticActorResolver{}}), oidc: oidc, employees: employees, sessionRows: rows, status: &status, verifier: verifier}
}

func TestAuthBFFLogoutKeepsRetryableSessionUntilHydraRevokes(t *testing.T) {
	fixture := newAuthBFFFixture(t, "")
	callback := authBFFLoginAndCallback(t, fixture, "/claims")
	var cookie *http.Cookie
	for _, item := range callback.Result().Cookies() {
		if item.Name == ssoSessionCookieName {
			cookie = item
		}
	}
	if cookie == nil {
		t.Fatal("missing session cookie")
	}
	response := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/logout", cookie)
	if response.Code != http.StatusFound || !strings.Contains(response.Result().Header.Get("Location"), "/oauth2/sessions/logout") || len(fixture.sessionRows.rows) != 1 {
		t.Fatalf("logout lost retryable session: %d", response.Code)
	}
	fixture.oidc.endErr = errors.New("Hydra outage")
	response = authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/logout", cookie)
	if response.Code != http.StatusServiceUnavailable || len(fixture.sessionRows.rows) != 1 {
		t.Fatalf("Hydra outage lost retryable session: %d", response.Code)
	}
	*fixture.status = "revoked"
	response = authBFFRequest(fixture.router, "http://localhost:8088/api/auth/access-token", cookie)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session still active: %d", response.Code)
	}
}

func TestAuthBFFBackchannelDeletesOnlyVerifiedSIDAndIsIdempotent(t *testing.T) {
	fixture := newAuthBFFFixture(t, "")
	authBFFLoginAndCallback(t, fixture, "/claims")
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://localhost:8088/api/auth/sso/backchannel-logout", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response := httptest.NewRecorder()
		fixture.router.ServeHTTP(response, r)
		return response
	}
	if response := request("logout_token=bad&logout_token=duplicate"); response.Code != http.StatusBadRequest || len(fixture.sessionRows.rows) != 1 {
		t.Fatalf("duplicate token accepted: %d", response.Code)
	}
	fixture.verifier.err = errors.New("bad signature")
	if response := request("logout_token=forged"); response.Code != http.StatusUnauthorized || len(fixture.sessionRows.rows) != 1 {
		t.Fatalf("forged token deleted session: %d", response.Code)
	}
	fixture.verifier.err = nil
	for range 2 {
		if response := request("logout_token=signed"); response.Code != http.StatusNoContent || len(fixture.sessionRows.rows) != 0 {
			t.Fatalf("verified logout failed: %d", response.Code)
		}
	}
}

func authBFFRequest(router http.Handler, target string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func authBFFLoginAndCallback(t *testing.T, fixture *authBFFFixture, returnTo string) *httptest.ResponseRecorder {
	t.Helper()
	login := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/login?returnTo="+url.QueryEscape(returnTo))
	if login.Code != http.StatusFound {
		t.Fatalf("login redirect failed: %d", login.Code)
	}
	callback := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/callback?code=code-1&state=expected-state", login.Result().Cookies()...)
	return callback
}

func TestAuthBFFLoginUsesPrivatePendingCookiesAndSafeReturnPath(t *testing.T) {
	fixture := newAuthBFFFixture(t, "")
	login := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/login?returnTo=%2F%2Fevil.example")
	if login.Code != http.StatusFound || !strings.HasPrefix(login.Result().Header.Get("Location"), "http://localhost:4444/oauth2/auth") {
		t.Fatalf("login did not redirect to Hydra: %d %s", login.Code, login.Result().Header.Get("Location"))
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 4 {
		t.Fatalf("expected four pending cookies, got %d", len(cookies))
	}
	for _, cookie := range cookies {
		if !cookie.HttpOnly || cookie.Path != "/api/auth/sso" || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
			t.Fatalf("unsafe pending cookie: %+v", cookie)
		}
	}
	callback := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/callback?code=code-1&state=expected-state", cookies...)
	if callback.Code != http.StatusFound || callback.Result().Header.Get("Location") != "/claims" {
		t.Fatalf("unsafe returnTo was not rejected: %d %s", callback.Code, callback.Result().Header.Get("Location"))
	}
}

func TestAuthBFFCallbackRejectsWrongStateBeforeProvisioning(t *testing.T) {
	fixture := newAuthBFFFixture(t, "")
	login := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/login")
	callback := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/sso/callback?code=code-1&state=wrong", login.Result().Cookies()...)
	if callback.Code != http.StatusBadRequest || len(fixture.employees.rows) != 0 || len(fixture.sessionRows.rows) != 0 {
		t.Fatalf("wrong state created identity or session: %d", callback.Code)
	}
}

func TestAuthBFFCallbackRejectsInvalidIDTokenBeforeProvisioning(t *testing.T) {
	fixture := newAuthBFFFixture(t, "")
	fixture.oidc.exchangeErr = errors.New("bad ID Token signature")
	callback := authBFFLoginAndCallback(t, fixture, "/claims")
	if callback.Code != http.StatusBadGateway || len(fixture.employees.rows) != 0 || len(fixture.sessionRows.rows) != 0 {
		t.Fatalf("invalid ID Token created identity or session: %d", callback.Code)
	}
}

func TestAuthBFFAccessTokenPreservesReactJSONAndJWTContract(t *testing.T) {
	fixture := newAuthBFFFixture(t, "ou_member")
	callback := authBFFLoginAndCallback(t, fixture, "/claims")
	if callback.Code != http.StatusFound || callback.Result().Header.Get("Location") != "/claims" {
		t.Fatalf("callback failed: %d %s", callback.Code, callback.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == "reimbursement_sso_session" {
			sessionCookie = cookie
		}
	}
	if sessionCookie == nil || !sessionCookie.HttpOnly || sessionCookie.Path != "/api/auth" || len(fixture.sessionRows.rows) != 1 {
		t.Fatal("server-side React session was not established")
	}
	response := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/access-token", sessionCookie)
	if response.Code != http.StatusOK || response.Result().Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("access-token failed: %d %s", response.Code, response.Body.String())
	}
	var body struct {
		AccessToken string `json:"accessToken"`
		ExpiresAt   string `json:"expiresAt"`
		Employee    struct {
			ID          string `json:"id"`
			DisplayName string `json:"displayName"`
			Role        string `json:"role"`
		} `json:"employee"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Employee.ID != "employee-web-1" || body.Employee.DisplayName != "测试成员" || body.Employee.Role != "ADMIN" || body.AccessToken == "" || body.ExpiresAt == "" {
		t.Fatalf("React access-token contract changed: %+v", body)
	}
	parts := strings.Split(body.AccessToken, ".")
	if len(parts) != 3 {
		t.Fatal("access token is not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims["sub"] != "employee-web-1" || claims["aud"] != "reimbursement-api" || claims["channel"] != "web" || claims["sid"] != "hydra-sid-1" || claims["role"] != "ADMIN" || claims["exp"].(float64)-claims["iat"].(float64) != 900 {
		t.Fatalf("Web JWT claims changed: %+v", claims)
	}
	resolver, err := NewHS256BearerResolver(strings.Repeat("j", 32), "reimbursement-api")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/claims", nil)
	request.Header.Set("Authorization", "Bearer "+body.AccessToken)
	if _, err := resolver.Resolve(request); err != nil {
		t.Fatalf("Go rejected its new JWT signature: %v", err)
	}
}

func TestAuthBFFAccessTokenFailsClosedForNoSessionRevocationAndOutage(t *testing.T) {
	fixture := newAuthBFFFixture(t, "")
	if response := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/access-token"); response.Code != http.StatusUnauthorized {
		t.Fatalf("missing session should be 401: %d", response.Code)
	}
	callback := authBFFLoginAndCallback(t, fixture, "/claims")
	var sessionCookie *http.Cookie
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == "reimbursement_sso_session" {
			sessionCookie = cookie
		}
	}
	if sessionCookie == nil {
		t.Fatal("missing session cookie")
	}
	*fixture.status = "revoked"
	if response := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/access-token", sessionCookie); response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked sid should be 401: %d", response.Code)
	}
	*fixture.status = "outage"
	if response := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/access-token", sessionCookie); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("SSO outage should be 503: %d", response.Code)
	}
	*fixture.status = "active"
	identity := fixture.employees.rows["employee-web-1"]
	identity.IsActive = false
	fixture.employees.rows[identity.ID] = identity
	if response := authBFFRequest(fixture.router, "http://localhost:8088/api/auth/access-token", sessionCookie); response.Code != http.StatusUnauthorized {
		t.Fatalf("inactive employee should be 401: %d", response.Code)
	}
}

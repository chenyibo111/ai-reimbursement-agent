package transport

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/auth"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

const ssoSessionCookieName = "reimbursement_sso_session"

type AuthOIDC interface {
	Begin(context.Context, string) (auth.Authorization, error)
	Exchange(context.Context, string, auth.PendingAuth) (auth.VerifiedIdentity, error)
	EndSession(context.Context, string) (url.URL, error)
}

type AuthEmployees interface {
	ResolveMember(context.Context, store.MemberIdentity) (store.EmployeeIdentity, error)
	FindEmployeeByID(context.Context, string) (*store.EmployeeIdentity, error)
}

type AuthLogoutVerifier interface {
	Verify(context.Context, string) (string, error)
}

type AuthBFFConfig struct {
	SigningSecret  string
	AdminOpenIDs   string
	FinanceOpenIDs string
	SecureCookie   bool
	PostLogoutURI  string
	LogoutVerifier AuthLogoutVerifier
	SSOAppID       string
	TenantKey      string
}

type AuthBFF struct {
	oidc      AuthOIDC
	sessions  *auth.SessionService
	employees AuthEmployees
	config    AuthBFFConfig
	now       func() time.Time
}

func NewAuthBFF(oidc AuthOIDC, sessions *auth.SessionService, employees AuthEmployees, config AuthBFFConfig) (*AuthBFF, error) {
	if oidc == nil || sessions == nil || employees == nil || len(config.SigningSecret) < 32 || config.PostLogoutURI == "" || config.LogoutVerifier == nil || config.SSOAppID == "" || config.TenantKey == "" {
		return nil, fmt.Errorf("Go Auth BFF is not configured")
	}
	return &AuthBFF{oidc: oidc, sessions: sessions, employees: employees, config: config, now: time.Now}, nil
}

func (handler *AuthBFF) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/api/auth/sso/login":
		handler.login(response, request)
	case request.Method == http.MethodGet && request.URL.Path == "/api/auth/sso/callback":
		handler.callback(response, request)
	case request.Method == http.MethodGet && request.URL.Path == "/api/auth/access-token":
		handler.accessToken(response, request)
	case request.Method == http.MethodGet && request.URL.Path == "/api/auth/sso/logout":
		handler.logout(response, request)
	case request.Method == http.MethodPost && request.URL.Path == "/api/auth/sso/backchannel-logout":
		handler.backchannelLogout(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (handler *AuthBFF) logout(response http.ResponseWriter, request *http.Request) {
	cookie := readAuthCookie(request, ssoSessionCookieName)
	if cookie == "" {
		http.Redirect(response, request, handler.config.PostLogoutURI, http.StatusFound)
		return
	}
	session, err := handler.sessions.Active(request.Context(), cookie)
	if errors.Is(err, auth.ErrUnauthenticated) {
		handler.clearSession(response)
		http.Redirect(response, request, handler.config.PostLogoutURI, http.StatusFound)
		return
	}
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "sso_logout_unavailable")
		return
	}
	target, err := handler.oidc.EndSession(request.Context(), session.IDToken)
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "sso_logout_unavailable")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	http.Redirect(response, request, target.String(), http.StatusFound)
}

func (handler *AuthBFF) backchannelLogout(response http.ResponseWriter, request *http.Request) {
	if !strings.HasPrefix(request.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		writeAuthError(response, http.StatusBadRequest, "invalid_logout_request")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 16*1024)
	if err := request.ParseForm(); err != nil {
		writeAuthError(response, http.StatusBadRequest, "invalid_logout_request")
		return
	}
	tokens := request.PostForm["logout_token"]
	if len(tokens) != 1 || tokens[0] == "" {
		writeAuthError(response, http.StatusBadRequest, "invalid_logout_request")
		return
	}
	sid, err := handler.config.LogoutVerifier.Verify(request.Context(), tokens[0])
	if err != nil {
		writeAuthError(response, http.StatusUnauthorized, "invalid_logout_token")
		return
	}
	if err := handler.sessions.DeleteBySID(request.Context(), sid); err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "session_store_unavailable")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *AuthBFF) clearSession(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{Name: ssoSessionCookieName, Path: "/api/auth", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: handler.config.SecureCookie})
}

func (handler *AuthBFF) login(response http.ResponseWriter, request *http.Request) {
	authorization, err := handler.oidc.Begin(request.Context(), safeReturnTo(request.URL.Query().Get("returnTo")))
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "sso_unavailable")
		return
	}
	for _, item := range []struct{ name, value string }{
		{"sso_oauth_state", authorization.Pending.State},
		{"sso_oauth_nonce", authorization.Pending.Nonce},
		{"sso_oauth_verifier", authorization.Pending.Verifier},
		{"sso_oauth_return_to", url.QueryEscape(authorization.Pending.ReturnTo)},
	} {
		http.SetCookie(response, &http.Cookie{Name: item.name, Value: item.value, Path: "/api/auth/sso", MaxAge: 600, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: handler.config.SecureCookie})
	}
	response.Header().Set("Cache-Control", "no-store")
	http.Redirect(response, request, authorization.URL, http.StatusFound)
}

func (handler *AuthBFF) callback(response http.ResponseWriter, request *http.Request) {
	state := readAuthCookie(request, "sso_oauth_state")
	received := request.URL.Query().Get("state")
	pending := auth.PendingAuth{State: state, Nonce: readAuthCookie(request, "sso_oauth_nonce"), Verifier: readAuthCookie(request, "sso_oauth_verifier")}
	decodedReturnTo, err := url.QueryUnescape(readAuthCookie(request, "sso_oauth_return_to"))
	if err == nil {
		pending.ReturnTo = safeReturnTo(decodedReturnTo)
	}
	code := request.URL.Query().Get("code")
	handler.clearPending(response)
	if state == "" || received == "" || len(state) != len(received) || subtle.ConstantTimeCompare([]byte(state), []byte(received)) != 1 || pending.Nonce == "" || pending.Verifier == "" || code == "" {
		writeAuthError(response, http.StatusBadRequest, "invalid_sso_callback")
		return
	}
	identity, err := handler.oidc.Exchange(request.Context(), code, pending)
	if err != nil {
		writeAuthError(response, http.StatusBadGateway, "sso_login_failed")
		return
	}
	if identity.FeishuAppID != handler.config.SSOAppID || identity.FeishuTenantKey != handler.config.TenantKey || identity.FeishuUserID == "" {
		writeAuthError(response, http.StatusForbidden, "sso_identity_not_allowed")
		return
	}
	displayName := strings.TrimSpace(identity.DisplayName)
	if displayName == "" {
		displayName = "飞书员工"
	}
	employee, err := handler.employees.ResolveMember(request.Context(), store.MemberIdentity{TenantKey: identity.FeishuTenantKey, UserID: identity.FeishuUserID, AppID: identity.FeishuAppID, OpenID: identity.FeishuOpenID, DisplayName: displayName, Role: handler.roleFor(identity.FeishuOpenID)})
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "identity_provisioning_unavailable")
		return
	}
	if !employee.IsActive {
		writeAuthError(response, http.StatusForbidden, "employee_inactive")
		return
	}
	cookie, err := handler.sessions.Create(request.Context(), employee.ID, identity.SID, identity.IDToken, identity.ExpiresAt)
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "session_store_unavailable")
		return
	}
	maxAge := int(time.Until(identity.ExpiresAt).Seconds())
	if maxAge < 0 {
		maxAge = 0
	}
	http.SetCookie(response, &http.Cookie{Name: ssoSessionCookieName, Value: cookie, Path: "/api/auth", MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: handler.config.SecureCookie})
	response.Header().Set("Cache-Control", "no-store")
	http.Redirect(response, request, safeReturnTo(pending.ReturnTo), http.StatusFound)
}

func (handler *AuthBFF) accessToken(response http.ResponseWriter, request *http.Request) {
	cookie := readAuthCookie(request, ssoSessionCookieName)
	session, err := handler.sessions.Active(request.Context(), cookie)
	if errors.Is(err, auth.ErrUnauthenticated) {
		writeAuthError(response, http.StatusUnauthorized, "UNAUTHENTICATED")
		return
	}
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "IDENTITY_PROVISIONING_UNAVAILABLE")
		return
	}
	employee, err := handler.employees.FindEmployeeByID(request.Context(), session.EmployeeID)
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "IDENTITY_PROVISIONING_UNAVAILABLE")
		return
	}
	if employee == nil || !employee.IsActive {
		writeAuthError(response, http.StatusUnauthorized, "UNAUTHENTICATED")
		return
	}
	issuedAt := handler.now().UTC().Truncate(time.Second)
	expiresAt := issuedAt.Add(15 * time.Minute)
	token, err := signWebJWT(employee.ID, employee.Role, session.SID, handler.config.SigningSecret, issuedAt)
	if err != nil {
		writeAuthError(response, http.StatusServiceUnavailable, "IDENTITY_PROVISIONING_UNAVAILABLE")
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(response).Encode(map[string]any{"accessToken": token, "expiresAt": expiresAt.Format(time.RFC3339), "employee": map[string]string{"id": employee.ID, "displayName": employee.DisplayName, "role": employee.Role}})
}

func (handler *AuthBFF) roleFor(openID string) string {
	if listedOpenID(handler.config.AdminOpenIDs, openID) {
		return "ADMIN"
	}
	if listedOpenID(handler.config.FinanceOpenIDs, openID) {
		return "FINANCE_REVIEWER"
	}
	return "EMPLOYEE"
}

func listedOpenID(csv, value string) bool {
	for _, item := range strings.Split(csv, ",") {
		if strings.TrimSpace(item) == value {
			return true
		}
	}
	return false
}

func (handler *AuthBFF) clearPending(response http.ResponseWriter) {
	for _, name := range []string{"sso_oauth_state", "sso_oauth_nonce", "sso_oauth_verifier", "sso_oauth_return_to"} {
		http.SetCookie(response, &http.Cookie{Name: name, Path: "/api/auth/sso", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: handler.config.SecureCookie})
	}
}

func readAuthCookie(request *http.Request, name string) string {
	cookie, err := request.Cookie(name)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func safeReturnTo(value string) string {
	if value == "" || len(value) > 2048 || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "\\\r\n") {
		return "/claims"
	}
	decoded, err := url.QueryUnescape(value)
	if err != nil || !strings.HasPrefix(decoded, "/") || strings.HasPrefix(decoded, "//") || strings.ContainsAny(decoded, "\\\r\n") {
		return "/claims"
	}
	return value
}

func signWebJWT(employeeID, role, sid, secret string, now time.Time) (string, error) {
	if employeeID == "" || sid == "" || !validRole(role) || len(secret) < 32 {
		return "", fmt.Errorf("invalid Web JWT identity")
	}
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, _ := json.Marshal(map[string]any{"sub": employeeID, "role": role, "aud": "reimbursement-api", "channel": "web", "sid": sid, "iat": now.Unix(), "exp": now.Add(15 * time.Minute).Unix()})
	signed := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func writeAuthError(response http.ResponseWriter, status int, code string) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]string{"code": code})
}

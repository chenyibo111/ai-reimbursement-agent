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
	"strings"
	"time"
)

var ErrUnauthenticated = errors.New("unauthenticated")

type Actor struct {
	ID      string
	Role    string
	Channel string
}

type ActorResolver interface {
	Resolve(*http.Request) (Actor, error)
}

type EmployeeActivityChecker interface {
	IsActive(context.Context, string) (bool, error)
}
type EmployeeActivityFunc func(context.Context, string) (bool, error)

func (fn EmployeeActivityFunc) IsActive(ctx context.Context, employeeID string) (bool, error) {
	return fn(ctx, employeeID)
}

type SSOSessionChecker interface {
	IsActive(context.Context, string) (bool, error)
}
type SSOSessionFunc func(context.Context, string) (bool, error)

func (fn SSOSessionFunc) IsActive(ctx context.Context, sid string) (bool, error) {
	return fn(ctx, sid)
}
func (fn SSOSessionFunc) RecordActivity(ctx context.Context, sid string) (bool, error) {
	return fn(ctx, sid)
}

// StaticActorResolver is intentionally suitable only for tests and local
// development wiring. Production replaces it with a signed OIDC resolver.
type StaticActorResolver struct{}

func (StaticActorResolver) Resolve(request *http.Request) (Actor, error) {
	value := strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
	if value == "" || value == request.Header.Get("Authorization") {
		return Actor{}, ErrUnauthenticated
	}
	return Actor{ID: value, Role: "EMPLOYEE", Channel: "web"}, nil
}

type HS256BearerResolver struct {
	secret   []byte
	audience string
	now      func() int64
}

type WebBearerResolver struct {
	*HS256BearerResolver
	employees EmployeeActivityChecker
	sessions  SSOSessionChecker
}

func NewHS256BearerResolver(secret string, audience string) (*HS256BearerResolver, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, fmt.Errorf("bearer token secret is required")
	}
	return &HS256BearerResolver{secret: []byte(secret), audience: audience, now: func() int64 { return time.Now().Unix() }}, nil
}

func NewWebBearerResolver(secret string, audience string, employees EmployeeActivityChecker, sessions SSOSessionChecker) (*WebBearerResolver, error) {
	bearer, err := NewHS256BearerResolver(secret, audience)
	if err != nil {
		return nil, err
	}
	if employees == nil || sessions == nil {
		return nil, fmt.Errorf("web employee and SSO session checks are required")
	}
	return &WebBearerResolver{HS256BearerResolver: bearer, employees: employees, sessions: sessions}, nil
}

func (resolver *HS256BearerResolver) Resolve(request *http.Request) (Actor, error) {
	claims, err := resolver.claims(request)
	if err != nil {
		return Actor{}, err
	}
	return Actor{ID: claims.Subject, Role: claims.Role, Channel: claims.Channel}, nil
}

func (resolver *WebBearerResolver) Resolve(request *http.Request) (Actor, error) {
	claims, err := resolver.HS256BearerResolver.claims(request)
	if err != nil || claims.Channel != "web" || strings.TrimSpace(claims.SID) == "" {
		return Actor{}, ErrUnauthenticated
	}
	actor := Actor{ID: claims.Subject, Role: claims.Role, Channel: claims.Channel}
	if resolver.employees != nil {
		active, activityErr := resolver.employees.IsActive(request.Context(), actor.ID)
		if activityErr != nil || !active {
			return Actor{}, ErrUnauthenticated
		}
	}
	active, sessionErr := resolver.sessions.IsActive(request.Context(), claims.SID)
	if sessionErr != nil || !active {
		return Actor{}, ErrUnauthenticated
	}
	return actor, nil
}

type bearerClaims struct {
	Subject   string `json:"sub"`
	Role      string `json:"role"`
	Channel   string `json:"channel"`
	Audience  any    `json:"aud"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	JTI       string `json:"jti"`
	SID       string `json:"sid"`
}

func (resolver *HS256BearerResolver) claims(request *http.Request) (bearerClaims, error) {
	value := strings.TrimSpace(request.Header.Get("Authorization"))
	if !strings.HasPrefix(value, "Bearer ") {
		return bearerClaims{}, ErrUnauthenticated
	}
	parts := strings.Split(strings.TrimSpace(strings.TrimPrefix(value, "Bearer ")), ".")
	if len(parts) != 3 {
		return bearerClaims{}, ErrUnauthenticated
	}
	signed := parts[0] + "." + parts[1]
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return bearerClaims{}, ErrUnauthenticated
	}
	mac := hmac.New(sha256.New, resolver.secret)
	_, _ = mac.Write([]byte(signed))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return bearerClaims{}, ErrUnauthenticated
	}
	var claims bearerClaims
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payload, &claims) != nil || strings.TrimSpace(claims.Subject) == "" || claims.IssuedAt <= 0 || claims.ExpiresAt <= resolver.now() || !matchesAudience(claims.Audience, resolver.audience) || !validRole(claims.Role) || (claims.Channel != "web" && claims.Channel != "agent") {
		return bearerClaims{}, ErrUnauthenticated
	}
	return claims, nil
}

func matchesAudience(value any, expected string) bool {
	if value == expected {
		return true
	}
	values, ok := value.([]any)
	if !ok {
		return false
	}
	for _, entry := range values {
		if entry == expected {
			return true
		}
	}
	return false
}

type DelegatedAgentResolver struct {
	bearer     *HS256BearerResolver
	serviceKey []byte
	employees  EmployeeActivityChecker
}

type CombinedActorResolver struct {
	web   ActorResolver
	agent ActorResolver
}

func NewCombinedActorResolver(web ActorResolver, agent ActorResolver) CombinedActorResolver {
	return CombinedActorResolver{web: web, agent: agent}
}

func (resolver CombinedActorResolver) Resolve(request *http.Request) (Actor, error) {
	if strings.TrimSpace(request.Header.Get("X-Agent-Service-Key")) != "" {
		return resolver.agent.Resolve(request)
	}
	return resolver.web.Resolve(request)
}

func NewDelegatedAgentResolver(bearer *HS256BearerResolver, serviceKey string, employees EmployeeActivityChecker) (*DelegatedAgentResolver, error) {
	if bearer == nil || strings.TrimSpace(serviceKey) == "" || employees == nil {
		return nil, fmt.Errorf("delegated agent authentication is not configured")
	}
	return &DelegatedAgentResolver{bearer: bearer, serviceKey: []byte(serviceKey), employees: employees}, nil
}

func (resolver *DelegatedAgentResolver) Resolve(request *http.Request) (Actor, error) {
	if subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Agent-Service-Key")), resolver.serviceKey) != 1 {
		return Actor{}, ErrUnauthenticated
	}
	actor, err := resolver.bearer.Resolve(request)
	if err != nil {
		return Actor{}, err
	}
	claims, err := resolver.bearer.claims(request)
	if err != nil || strings.TrimSpace(claims.JTI) == "" || actor.Channel != "agent" {
		return Actor{}, ErrUnauthenticated
	}
	active, err := resolver.employees.IsActive(request.Context(), actor.ID)
	if err != nil || !active {
		return Actor{}, ErrUnauthenticated
	}
	return actor, nil
}

func validRole(value string) bool {
	return value == "EMPLOYEE" || value == "FINANCE_REVIEWER" || value == "ADMIN"
}

type actorContextKey struct{}

func ActorFromContext(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(actorContextKey{}).(Actor)
	return actor, ok
}

func Authenticate(resolver ActorResolver, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		actor, err := resolver.Resolve(request)
		if err != nil || actor.ID == "" {
			writeError(response, http.StatusUnauthorized, "UNAUTHENTICATED", "请先登录后再操作")
			return
		}
		next.ServeHTTP(response, request.WithContext(context.WithValue(request.Context(), actorContextKey{}, actor)))
	})
}

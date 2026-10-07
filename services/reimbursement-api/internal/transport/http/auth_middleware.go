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

type Actor struct{ ID string }

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

// StaticActorResolver is intentionally suitable only for tests and local
// development wiring. Production replaces it with a signed OIDC resolver.
type StaticActorResolver struct{}

func (StaticActorResolver) Resolve(request *http.Request) (Actor, error) {
	value := strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
	if value == "" || value == request.Header.Get("Authorization") {
		return Actor{}, ErrUnauthenticated
	}
	return Actor{ID: value}, nil
}

type HS256BearerResolver struct {
	secret   []byte
	audience string
	now      func() int64
}

func NewHS256BearerResolver(secret string, audience string) (*HS256BearerResolver, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, fmt.Errorf("bearer token secret is required")
	}
	return &HS256BearerResolver{secret: []byte(secret), audience: audience, now: func() int64 { return time.Now().Unix() }}, nil
}

func (resolver *HS256BearerResolver) Resolve(request *http.Request) (Actor, error) {
	value := strings.TrimSpace(request.Header.Get("Authorization"))
	if !strings.HasPrefix(value, "Bearer ") {
		return Actor{}, ErrUnauthenticated
	}
	parts := strings.Split(strings.TrimSpace(strings.TrimPrefix(value, "Bearer ")), ".")
	if len(parts) != 3 {
		return Actor{}, ErrUnauthenticated
	}
	signed := parts[0] + "." + parts[1]
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Actor{}, ErrUnauthenticated
	}
	mac := hmac.New(sha256.New, resolver.secret)
	_, _ = mac.Write([]byte(signed))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return Actor{}, ErrUnauthenticated
	}
	var claims struct {
		Subject   string `json:"sub"`
		Audience  any    `json:"aud"`
		ExpiresAt int64  `json:"exp"`
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payload, &claims) != nil || strings.TrimSpace(claims.Subject) == "" || claims.ExpiresAt <= resolver.now() || !matchesAudience(claims.Audience, resolver.audience) {
		return Actor{}, ErrUnauthenticated
	}
	return Actor{ID: claims.Subject}, nil
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
	parts := strings.Split(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "), ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Actor{}, ErrUnauthenticated
	}
	var claims struct {
		JTI     string `json:"jti"`
		Channel string `json:"channel"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.JTI == "" || claims.Channel != "agent" {
		return Actor{}, ErrUnauthenticated
	}
	active, err := resolver.employees.IsActive(request.Context(), actor.ID)
	if err != nil || !active {
		return Actor{}, ErrUnauthenticated
	}
	return actor, nil
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

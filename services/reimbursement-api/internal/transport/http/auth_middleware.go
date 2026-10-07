package transport

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
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

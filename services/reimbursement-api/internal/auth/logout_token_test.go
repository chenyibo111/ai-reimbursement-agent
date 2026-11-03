package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

type logoutTestProvider struct {
	url    url.URL
	client *http.Client
}

func (p logoutTestProvider) JWKSURL(context.Context) (url.URL, error) { return p.url, nil }
func (p logoutTestProvider) HTTPClient() *http.Client                 { return p.client }

func TestLogoutTokenVerifierAcceptsOnlyTrustedRecentOIDCNotification(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "trusted", Algorithm: string(jose.RS256), Use: "sig"}}})
	}))
	defer jwks.Close()
	parsedURL, _ := url.Parse(jwks.URL)
	verifier := NewLogoutTokenVerifier(logoutTestProvider{url: *parsedURL, client: jwks.Client()}, "http://localhost:4444/", "reimbursement-web")
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "trusted"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	sign := func(changes map[string]any, signingKey jose.Signer) string {
		claims := map[string]any{"iss": "http://localhost:4444/", "aud": []string{"reimbursement-web"}, "iat": time.Now().Unix(), "jti": "unique", "sid": "session-1", "events": map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}}}
		for name, value := range changes {
			claims[name] = value
		}
		raw, err := jwt.Signed(signingKey).Claims(claims).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	valid := sign(nil, signer)
	if sid, err := verifier.Verify(context.Background(), valid); err != nil || sid != "session-1" {
		t.Fatalf("valid logout rejected: %q %v", sid, err)
	}
	forgedKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	forgedSigner, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: forgedKey, KeyID: "trusted"}}, nil)
	invalid := []struct {
		name  string
		token string
	}{
		{"forged key", sign(nil, forgedSigner)}, {"issuer", sign(map[string]any{"iss": "http://evil/"}, signer)},
		{"audience", sign(map[string]any{"aud": []string{"reimbursement-web", "other"}}, signer)},
		{"stale", sign(map[string]any{"iat": time.Now().Add(-6 * time.Minute).Unix()}, signer)},
		{"future", sign(map[string]any{"iat": time.Now().Add(2 * time.Minute).Unix()}, signer)},
		{"nonce", sign(map[string]any{"nonce": nil}, signer)},
		{"event", sign(map[string]any{"events": map[string]any{"http://schemas.openid.net/event/backchannel-logout": nil}}, signer)},
		{"sid", sign(map[string]any{"sid": ""}, signer)},
		{"jti", sign(map[string]any{"jti": ""}, signer)},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			if sid, err := verifier.Verify(context.Background(), tc.token); err == nil {
				t.Fatalf("invalid notification accepted: %q", sid)
			}
		})
	}
}

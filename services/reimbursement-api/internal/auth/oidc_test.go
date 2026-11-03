package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type oidcFixture struct {
	server    *httptest.Server
	client    *OIDCClient
	trusted   *rsa.PrivateKey
	untrusted *rsa.PrivateKey
	nonce     string
	variant   string
	t         *testing.T
}

func newOIDCFixture(t *testing.T) *oidcFixture {
	t.Helper()
	trusted, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	untrusted, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &oidcFixture{trusted: trusted, untrusted: untrusted, t: t}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	f.client, err = NewOIDCClient(OIDCConfig{
		IssuerURL:     f.server.URL + "/",
		ClientID:      "reimbursement-web",
		RedirectURI:   "http://localhost:8088/api/auth/sso/callback",
		PostLogoutURI: "http://localhost:8088/logged-out",
		HTTPClient:    f.server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *oidcFixture) serve(response http.ResponseWriter, request *http.Request) {
	issuer := f.server.URL + "/"
	switch request.URL.Path {
	case "/.well-known/openid-configuration":
		_ = json.NewEncoder(response).Encode(map[string]any{
			"issuer": issuer, "authorization_endpoint": f.server.URL + "/oauth2/auth",
			"token_endpoint": f.server.URL + "/oauth2/token", "jwks_uri": f.server.URL + "/.well-known/jwks.json",
			"end_session_endpoint":     f.server.URL + "/oauth2/sessions/logout",
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"}, "token_endpoint_auth_methods_supported": []string{"none"},
		})
	case "/.well-known/jwks.json":
		_ = json.NewEncoder(response).Encode(map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "kid": "trusted-key", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(f.trusted.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.trusted.E)).Bytes()),
		}}})
	case "/oauth2/token":
		if request.FormValue("redirect_uri") != "http://localhost:8088/api/auth/sso/callback" || request.FormValue("code_verifier") == "" || request.FormValue("client_id") != "reimbursement-web" {
			f.t.Errorf("token request lost registered redirect, verifier, or client ID")
		}
		key := f.trusted
		if f.variant == "forged" {
			key = f.untrusted
		}
		claims := map[string]any{
			"iss": issuer, "aud": "reimbursement-web", "sub": "fs_test_member", "sid": "hydra-sid-1",
			"feishu_open_id": "ou_test_member", "name": "测试成员", "nonce": f.nonce,
			"iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(time.Hour).Unix(),
		}
		switch f.variant {
		case "issuer":
			claims["iss"] = "http://other-issuer.invalid/"
		case "audience":
			claims["aud"] = "other-client"
		case "expired":
			claims["exp"] = time.Now().Add(-time.Minute).Unix()
		case "nonce":
			claims["nonce"] = "wrong-nonce"
		case "sid":
			delete(claims, "sid")
		case "open_id":
			delete(claims, "feishu_open_id")
		}
		raw := signFixtureIDToken(f.t, key, claims)
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"access_token": "unused", "token_type": "Bearer", "expires_in": 3600, "id_token": raw})
	default:
		http.NotFound(response, request)
	}
}

func signFixtureIDToken(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"trusted-key","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signed := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(signed))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signed + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func TestOIDCBeginUsesPKCEStateNonceAndRegisteredCallback(t *testing.T) {
	f := newOIDCFixture(t)
	authorization, err := f.client.Begin(context.Background(), "/claims")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(authorization.URL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	challenge := sha256.Sum256([]byte(authorization.Pending.Verifier))
	if query.Get("client_id") != "reimbursement-web" || query.Get("redirect_uri") != "http://localhost:8088/api/auth/sso/callback" || query.Get("scope") != "openid profile feishu_identity" || query.Get("state") != authorization.Pending.State || query.Get("nonce") != authorization.Pending.Nonce || query.Get("code_challenge_method") != "S256" || query.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) || len(authorization.Pending.Verifier) < 43 || authorization.Pending.ReturnTo != "/claims" {
		t.Fatalf("incomplete OIDC authorization: %s, pending=%+v", parsed.String(), authorization.Pending)
	}
	second, err := f.client.Begin(context.Background(), "/claims")
	if err != nil || second.Pending.State == authorization.Pending.State || second.Pending.Nonce == authorization.Pending.Nonce {
		t.Fatal("each authorization must use fresh state and nonce")
	}
	end, err := f.client.EndSession(context.Background(), "signed-id-token")
	if err != nil || end.Query().Get("id_token_hint") != "signed-id-token" || end.Query().Get("post_logout_redirect_uri") != "http://localhost:8088/logged-out" {
		t.Fatalf("end-session URL is incomplete: %v, %v", end, err)
	}
}

func TestOIDCExchangeAcceptsOnlyVerifiedFeishuIdentity(t *testing.T) {
	f := newOIDCFixture(t)
	authorization, err := f.client.Begin(context.Background(), "/claims")
	if err != nil {
		t.Fatal(err)
	}
	f.nonce = authorization.Pending.Nonce
	identity, err := f.client.Exchange(context.Background(), "code-1", authorization.Pending)
	if err != nil || identity.Subject != "fs_test_member" || identity.SID != "hydra-sid-1" || identity.FeishuOpenID != "ou_test_member" || identity.DisplayName != "测试成员" || identity.IDToken == "" {
		t.Fatalf("verified identity not accepted: %+v, %v", identity, err)
	}
}

func TestOIDCExchangeRejectsForgedAndIncompleteTokens(t *testing.T) {
	for _, variant := range []string{"forged", "issuer", "audience", "expired", "nonce", "sid", "open_id"} {
		t.Run(variant, func(t *testing.T) {
			f := newOIDCFixture(t)
			authorization, err := f.client.Begin(context.Background(), "/claims")
			if err != nil {
				t.Fatal(err)
			}
			f.nonce = authorization.Pending.Nonce
			f.variant = variant
			identity, err := f.client.Exchange(context.Background(), "code-1", authorization.Pending)
			if err == nil || identity.FeishuOpenID != "" {
				t.Fatalf("%s token should be rejected: %+v, %v", variant, identity, err)
			}
		})
	}
}

func TestOIDCConfigRejectsMissingClient(t *testing.T) {
	_, err := NewOIDCClient(OIDCConfig{IssuerURL: "http://localhost:4444/", RedirectURI: "http://localhost:8088/api/auth/sso/callback"})
	if err == nil || !strings.Contains(err.Error(), "client") {
		t.Fatalf("incomplete OIDC config should fail: %v", err)
	}
}

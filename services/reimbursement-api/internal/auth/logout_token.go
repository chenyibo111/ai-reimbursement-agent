package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

const logoutEvent = "http://schemas.openid.net/event/backchannel-logout"

type LogoutJWKSProvider interface {
	JWKSURL(context.Context) (url.URL, error)
	HTTPClient() *http.Client
}

type LogoutTokenVerifier struct {
	provider         LogoutJWKSProvider
	issuer, audience string
	now              func() time.Time
}

func NewLogoutTokenVerifier(provider LogoutJWKSProvider, issuer, audience string) *LogoutTokenVerifier {
	return &LogoutTokenVerifier{provider: provider, issuer: issuer, audience: audience, now: time.Now}
}

func (verifier *LogoutTokenVerifier) Verify(ctx context.Context, raw string) (string, error) {
	if verifier == nil || verifier.provider == nil || raw == "" || len(raw) > 16*1024 {
		return "", errors.New("invalid logout token size")
	}
	parsed, err := jwt.ParseSigned(raw, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil || len(parsed.Headers) != 1 || parsed.Headers[0].KeyID == "" {
		return "", errors.New("invalid logout token header")
	}
	jwksURL, err := verifier.provider.JWKSURL(ctx)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL.String(), nil)
	if err != nil {
		return "", err
	}
	client := verifier.provider.HTTPClient()
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("JWKS unavailable")
	}
	var keys jose.JSONWebKeySet
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&keys); err != nil {
		return "", err
	}
	for _, key := range keys.Key(parsed.Headers[0].KeyID) {
		if key.Algorithm != "" && key.Algorithm != string(jose.RS256) || key.Use != "" && key.Use != "sig" {
			continue
		}
		var claims struct {
			Issuer   string                     `json:"iss"`
			Audience []string                   `json:"aud"`
			IssuedAt int64                      `json:"iat"`
			ID       string                     `json:"jti"`
			SID      string                     `json:"sid"`
			Nonce    json.RawMessage            `json:"nonce"`
			Events   map[string]json.RawMessage `json:"events"`
		}
		if err := parsed.Claims(key.Key, &claims); err != nil {
			continue
		}
		if claims.Issuer != verifier.issuer || len(claims.Audience) != 1 || claims.Audience[0] != verifier.audience || claims.ID == "" || claims.SID == "" || len(claims.Nonce) != 0 {
			continue
		}
		rawEvent, ok := claims.Events[logoutEvent]
		if !ok {
			continue
		}
		var event map[string]json.RawMessage
		if err := json.Unmarshal(rawEvent, &event); err != nil || event == nil {
			continue
		}
		age := verifier.now().Sub(time.Unix(claims.IssuedAt, 0))
		if claims.IssuedAt == 0 || age > 5*time.Minute || age < -time.Minute {
			continue
		}
		return claims.SID, nil
	}
	return "", errors.New("invalid logout token")
}

package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type OIDCConfig struct {
	IssuerURL     string
	ClientID      string
	RedirectURI   string
	PostLogoutURI string
	DialAddress   string
	HTTPClient    *http.Client
}

type PendingAuth struct {
	State    string
	Nonce    string
	Verifier string
	ReturnTo string
}

type Authorization struct {
	URL     string
	Pending PendingAuth
}

type VerifiedIdentity struct {
	Subject         string
	SID             string
	FeishuOpenID    string
	FeishuUserID    string
	FeishuTenantKey string
	FeishuAppID     string
	DisplayName     string
	ExpiresAt       time.Time
	IDToken         string
}

type OIDCClient struct {
	config OIDCConfig
	client *http.Client
}

func NewOIDCClient(config OIDCConfig) (*OIDCClient, error) {
	issuer, issuerErr := url.Parse(config.IssuerURL)
	redirect, redirectErr := url.Parse(config.RedirectURI)
	postLogout, logoutErr := url.Parse(config.PostLogoutURI)
	if issuerErr != nil || issuer == nil || (issuer.Scheme != "http" && issuer.Scheme != "https") || issuer.Host == "" {
		return nil, fmt.Errorf("invalid OIDC issuer")
	}
	if strings.TrimSpace(config.ClientID) == "" {
		return nil, fmt.Errorf("OIDC client ID is required")
	}
	if redirectErr != nil || redirect == nil || redirect.Host == "" || redirect.Scheme == "" || logoutErr != nil || postLogout == nil || postLogout.Host == "" || postLogout.Scheme == "" {
		return nil, fmt.Errorf("OIDC redirect and post-logout URLs are required")
	}
	client := config.HTTPClient
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		if config.DialAddress != "" {
			address, err := url.Parse("http://" + config.DialAddress)
			if err != nil || address.Host == "" || address.Path != "" {
				return nil, fmt.Errorf("invalid Hydra dial address")
			}
			client = &http.Client{Timeout: 5 * time.Second, Transport: &issuerDialTransport{base: transport, issuerHost: issuer.Host, dialHost: address.Host}}
		} else {
			client = &http.Client{Timeout: 5 * time.Second, Transport: transport}
		}
	}
	return &OIDCClient{config: config, client: client}, nil
}

func (client *OIDCClient) provider(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	ctx = oidc.ClientContext(ctx, client.client)
	provider, err := oidc.NewProvider(ctx, client.config.IssuerURL)
	if err != nil {
		return nil, nil, err
	}
	endpoint := provider.Endpoint()
	endpoint.AuthStyle = oauth2.AuthStyleInParams
	config := &oauth2.Config{ClientID: client.config.ClientID, RedirectURL: client.config.RedirectURI, Endpoint: endpoint, Scopes: []string{"openid", "profile", "feishu_identity"}}
	return provider, config, nil
}

func (client *OIDCClient) Begin(ctx context.Context, returnTo string, silent bool) (Authorization, error) {
	_, config, err := client.provider(ctx)
	if err != nil {
		return Authorization{}, err
	}
	state, err := randomOIDCValue()
	if err != nil {
		return Authorization{}, err
	}
	nonce, err := randomOIDCValue()
	if err != nil {
		return Authorization{}, err
	}
	verifier := oauth2.GenerateVerifier()
	options := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("nonce", nonce)}
	if silent {
		options = append(options, oauth2.SetAuthURLParam("prompt", "none"))
	}
	url := config.AuthCodeURL(state, options...)
	return Authorization{URL: url, Pending: PendingAuth{State: state, Nonce: nonce, Verifier: verifier, ReturnTo: returnTo}}, nil
}

func (client *OIDCClient) Exchange(ctx context.Context, code string, pending PendingAuth) (VerifiedIdentity, error) {
	if code == "" || pending.State == "" || pending.Nonce == "" || pending.Verifier == "" {
		return VerifiedIdentity{}, fmt.Errorf("incomplete OIDC callback")
	}
	provider, config, err := client.provider(ctx)
	if err != nil {
		return VerifiedIdentity{}, err
	}
	ctx = oidc.ClientContext(ctx, client.client)
	tokens, err := config.Exchange(ctx, code, oauth2.VerifierOption(pending.Verifier))
	if err != nil {
		return VerifiedIdentity{}, err
	}
	raw, ok := tokens.Extra("id_token").(string)
	if !ok || raw == "" {
		return VerifiedIdentity{}, fmt.Errorf("missing ID Token")
	}
	verified, err := provider.Verifier(&oidc.Config{ClientID: client.config.ClientID, SupportedSigningAlgs: []string{"RS256"}}).Verify(ctx, raw)
	if err != nil {
		return VerifiedIdentity{}, err
	}
	if verified.Nonce != pending.Nonce {
		return VerifiedIdentity{}, fmt.Errorf("OIDC nonce mismatch")
	}
	var claims struct {
		SID             string `json:"sid"`
		FeishuOpenID    string `json:"feishu_open_id"`
		FeishuUserID    string `json:"feishu_user_id"`
		FeishuTenantKey string `json:"feishu_tenant_key"`
		FeishuAppID     string `json:"feishu_app_id"`
		Name            string `json:"name"`
	}
	if err := verified.Claims(&claims); err != nil {
		return VerifiedIdentity{}, err
	}
	if !strings.HasPrefix(verified.Subject, "fs_") || strings.TrimSpace(claims.SID) == "" || !strings.HasPrefix(claims.FeishuOpenID, "ou_") || strings.TrimSpace(claims.FeishuUserID) == "" || strings.TrimSpace(claims.FeishuTenantKey) == "" || strings.TrimSpace(claims.FeishuAppID) == "" || !verified.Expiry.After(time.Now()) {
		return VerifiedIdentity{}, fmt.Errorf("incomplete SSO identity")
	}
	return VerifiedIdentity{Subject: verified.Subject, SID: claims.SID, FeishuOpenID: claims.FeishuOpenID, FeishuUserID: claims.FeishuUserID, FeishuTenantKey: claims.FeishuTenantKey, FeishuAppID: claims.FeishuAppID, DisplayName: claims.Name, ExpiresAt: verified.Expiry, IDToken: raw}, nil
}

func (client *OIDCClient) EndSession(ctx context.Context, idToken string) (url.URL, error) {
	provider, _, err := client.provider(ctx)
	if err != nil {
		return url.URL{}, err
	}
	var metadata struct {
		EndSessionEndpoint string `json:"end_session_endpoint"`
	}
	if err := provider.Claims(&metadata); err != nil || metadata.EndSessionEndpoint == "" {
		return url.URL{}, fmt.Errorf("missing OIDC end-session endpoint")
	}
	target, err := url.Parse(metadata.EndSessionEndpoint)
	if err != nil {
		return url.URL{}, err
	}
	query := target.Query()
	query.Set("id_token_hint", idToken)
	query.Set("post_logout_redirect_uri", client.config.PostLogoutURI)
	target.RawQuery = query.Encode()
	return *target, nil
}

func (client *OIDCClient) JWKSURL(ctx context.Context) (url.URL, error) {
	provider, _, err := client.provider(ctx)
	if err != nil {
		return url.URL{}, err
	}
	var metadata struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := provider.Claims(&metadata); err != nil || metadata.JWKSURI == "" {
		return url.URL{}, fmt.Errorf("missing OIDC JWKS URL")
	}
	parsed, err := url.Parse(metadata.JWKSURI)
	if err != nil {
		return url.URL{}, err
	}
	return *parsed, nil
}

func (client *OIDCClient) HTTPClient() *http.Client { return client.client }

func randomOIDCValue() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

type issuerDialTransport struct {
	base       http.RoundTripper
	issuerHost string
	dialHost   string
}

func (transport *issuerDialTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Host != transport.issuerHost {
		return transport.base.RoundTrip(request)
	}
	copy := request.Clone(request.Context())
	copy.URL.Host = transport.dialHost
	return transport.base.RoundTrip(copy)
}

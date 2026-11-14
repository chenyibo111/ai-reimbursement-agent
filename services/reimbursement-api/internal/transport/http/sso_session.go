package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPSSOSessionChecker struct {
	endpoint   string
	serviceKey string
	client     *http.Client
}

func NewHTTPSSOSessionChecker(endpoint, serviceKey string) (*HTTPSSOSessionChecker, error) {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || strings.TrimSpace(serviceKey) == "" {
		return nil, fmt.Errorf("SSO session status endpoint and service key are required")
	}
	return &HTTPSSOSessionChecker{endpoint: parsed.String(), serviceKey: serviceKey, client: &http.Client{Timeout: 5 * time.Second}}, nil
}

func (checker *HTTPSSOSessionChecker) IsActive(ctx context.Context, sid string) (bool, error) {
	return checker.check(ctx, sid, false)
}

func (checker *HTTPSSOSessionChecker) RecordActivity(ctx context.Context, sid string) (bool, error) {
	return checker.check(ctx, sid, true)
}

func (checker *HTTPSSOSessionChecker) check(ctx context.Context, sid string, activity bool) (bool, error) {
	payload, _ := json.Marshal(struct {
		SID      string `json:"sid"`
		Activity bool   `json:"activity,omitempty"`
	}{SID: sid, Activity: activity})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, checker.endpoint, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-SSO-Service-Key", checker.serviceKey)
	response, err := checker.client.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNoContent:
		return true, nil
	case http.StatusUnauthorized:
		return false, nil
	default:
		return false, fmt.Errorf("SSO session status returned %d", response.StatusCode)
	}
}

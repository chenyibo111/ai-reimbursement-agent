package transport

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const policySourceBodyLimit = 64 << 10
const policySourceResponseLimit = 1 << 20

var policySourcePath = regexp.MustCompile(`^/api/v1/admin/policy-sources(?:/([A-Za-z0-9_-]+)(?:/(sync|jobs/([A-Za-z0-9_-]+)))?)?$`)

type policySourceProxy struct {
	upstream   *url.URL
	serviceKey string
	role       func(context.Context, string) (string, error)
	client     *http.Client
}

func NewPolicySourceProxy(rawURL string, serviceKey string, role func(context.Context, string) (string, error)) (http.Handler, error) {
	upstream, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || upstream == nil || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Host == "" || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "" || upstream.Path != "" || strings.TrimSpace(serviceKey) == "" || role == nil {
		return nil, fmt.Errorf("agent policy administration is not configured")
	}
	return &policySourceProxy{upstream: upstream, serviceKey: serviceKey, role: role, client: &http.Client{Timeout: 5 * time.Second}}, nil
}

func (proxy *policySourceProxy) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	actor, ok := ActorFromContext(request.Context())
	if !ok {
		writeError(response, http.StatusUnauthorized, "UNAUTHENTICATED", "请先登录后再操作")
		return
	}
	currentRole, err := proxy.role(request.Context(), actor.ID)
	if actor.ID == "" || actor.Channel != "web" || actor.Role != "ADMIN" || err != nil || currentRole != "ADMIN" {
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无政策管理权限")
		return
	}
	match := policySourcePath.FindStringSubmatch(request.URL.Path)
	if match == nil || request.URL.RawQuery != "" || !allowedPolicySourceMethod(request.Method, match) {
		writeError(response, http.StatusNotFound, "NOT_FOUND", "未找到政策来源操作")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, policySourceBodyLimit))
	if err != nil {
		writeError(response, http.StatusRequestEntityTooLarge, "INVALID_REQUEST", "请求内容过大")
		return
	}
	target := *proxy.upstream
	target.Path = request.URL.Path
	upstreamRequest, err := http.NewRequestWithContext(request.Context(), request.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "政策来源请求无效")
		return
	}
	upstreamRequest.Header.Set("Content-Type", "application/json")
	upstreamRequest.Header.Set("X-Agent-Admin-Service-Key", proxy.serviceKey)
	upstreamRequest.Header.Set("X-Agent-Actor-ID", actor.ID)
	upstreamResponse, err := proxy.client.Do(upstreamRequest)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "POLICY_SOURCE_UNAVAILABLE", "政策来源服务暂不可用，请稍后重试")
		return
	}
	defer upstreamResponse.Body.Close()
	result, err := io.ReadAll(io.LimitReader(upstreamResponse.Body, policySourceResponseLimit+1))
	if err != nil || len(result) > policySourceResponseLimit {
		writeError(response, http.StatusBadGateway, "POLICY_SOURCE_UNAVAILABLE", "政策来源服务响应异常")
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(upstreamResponse.StatusCode)
	_, _ = response.Write(result)
}

func allowedPolicySourceMethod(method string, match []string) bool {
	if match[1] == "" {
		return method == http.MethodGet || method == http.MethodPost
	}
	if match[2] == "" {
		return method == http.MethodPatch
	}
	if match[2] == "sync" {
		return method == http.MethodPost
	}
	return match[3] != "" && method == http.MethodGet
}

package transport

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

type internalMemberHandler struct {
	members interface {
		ResolveMember(context.Context, store.MemberIdentity) (store.EmployeeIdentity, error)
	}
	serviceKey []byte
	botAppID   string
	tenantKey  string
}

func (handler *internalMemberHandler) resolve(response http.ResponseWriter, request *http.Request) {
	if subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Auth-Provisioning-Key")), handler.serviceKey) != 1 {
		writeError(response, http.StatusUnauthorized, "UNAUTHENTICATED", "身份解析未获授权")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 4096)
	var body struct {
		TenantKey   string `json:"tenantKey"`
		UserID      string `json:"userId"`
		AppID       string `json:"appId"`
		OpenID      string `json:"openId"`
		DisplayName string `json:"displayName"`
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || handler.botAppID == "" || handler.tenantKey == "" || body.AppID != handler.botAppID || body.TenantKey != handler.tenantKey {
		writeError(response, http.StatusForbidden, "IDENTITY_NOT_ALLOWED", "飞书身份不属于已配置应用或企业")
		return
	}
	identity, err := handler.members.ResolveMember(request.Context(), store.MemberIdentity{TenantKey: body.TenantKey, UserID: strings.TrimSpace(body.UserID), AppID: body.AppID, OpenID: strings.TrimSpace(body.OpenID), DisplayName: strings.TrimSpace(body.DisplayName)})
	if errors.Is(err, store.ErrEmployeeIdentityConflict) {
		writeError(response, http.StatusConflict, "IDENTITY_CONFLICT", "员工身份需要人工对账")
		return
	}
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "IDENTITY_UNAVAILABLE", "员工身份暂时无法验证")
		return
	}
	if !identity.IsActive {
		writeError(response, http.StatusForbidden, "EMPLOYEE_INACTIVE", "员工已停用")
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(response).Encode(map[string]string{"employeeId": identity.ID, "role": identity.Role})
}

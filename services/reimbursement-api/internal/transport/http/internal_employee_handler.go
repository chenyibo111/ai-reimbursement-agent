package transport

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type internalEmployeeHandler struct {
	service         EmployeeIdentityService
	provisioningKey []byte
}
type EmployeeIdentityService interface {
	Upsert(ctx context.Context, command application.EmployeeIdentityCommand) error
}

func (handler *internalEmployeeHandler) upsert(response http.ResponseWriter, request *http.Request) {
	if subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Auth-Provisioning-Key")), handler.provisioningKey) != 1 {
		writeError(response, http.StatusUnauthorized, "UNAUTHENTICATED", "身份同步未获授权")
		return
	}
	var body struct {
		DisplayName  string `json:"displayName"`
		FeishuOpenID string `json:"feishuOpenId"`
		Role         string `json:"role"`
		IsActive     bool   `json:"isActive"`
	}
	if json.NewDecoder(request.Body).Decode(&body) != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "员工身份参数无效")
		return
	}
	command := application.EmployeeIdentityCommand{EmployeeID: strings.TrimSpace(request.PathValue("employeeId")), DisplayName: strings.TrimSpace(body.DisplayName), FeishuOpenID: strings.TrimSpace(body.FeishuOpenID), Role: strings.TrimSpace(body.Role), IsActive: body.IsActive}
	if err := handler.service.Upsert(request.Context(), command); err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "员工身份参数无效")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}
